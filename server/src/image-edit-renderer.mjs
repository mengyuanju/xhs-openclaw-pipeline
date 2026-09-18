import { internalPrompt } from '../../src/prompt-runtime.mjs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { imagePageDisclosure } from './image-edit-lineage.mjs';
import { localizedTargetIsDisclosure, requestsDisclosureRemoval } from './image-edit-disclosure.mjs';
import { createAgentClient } from '../../src/agent-client.mjs';
import { ImageAlignmentServiceError, createImageAlignmentValidator } from '../../src/image-alignment.mjs';
import { imageHash, renderMask, renderRegionsMask, mergeWithMask, changedPixelMask, assertOutsideMask, safeRect, EDIT_WIDTH, EDIT_HEIGHT } from '../../src/image-edit-pixels.mjs';
import { aiDisclosureBadgeSvg, createAiDisclosureStyle, resolveAiDisclosureVisualStyle } from '../../src/ai-disclosure-badge.mjs';
import { businessPrompt, withPromptRuntime, promptExecutionSnapshot, promptProvenance } from '../../src/prompt-runtime.mjs';

const cleanText=s=>String(s).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
function occurrences(value, phrase) {
  const source=cleanText(value),target=cleanText(phrase);
  if(!target)return 0;
  let count=0,index=0;
  while((index=source.indexOf(target,index))!==-1){count++;index+=target.length;}
  return count;
}
export function disclosurePlacementRegion(overlay) {
  return safeRect({
    x:Number(overlay.x),
    y:Number(overlay.y),
    width:Number(overlay.width),
    height:Number(overlay.height),
  });
}
function governedImageEditPrompt(context,config,{reviewInstruction,contract,data}) {
  const prompt=config.imageEditPrompt??context.imageEditPrompt;
  if(!prompt?.content)throw new Error('缺少已发布图片编辑提示词，请在管理员提示词页面发布后重试');
  return withPromptRuntime({source:'IMAGE_EDIT_REQUEST',settings:null,capturedAt:prompt.capturedAt,prompts:{...promptExecutionSnapshot()?.prompts,IMAGE_EDIT_SYSTEM:prompt}},()=>businessPrompt('IMAGE_EDIT_SYSTEM',{
    variables:{query:context.task.query,category:context.task.input?.category,targetAudience:context.task.input?.targetAudience,
      imageIndex:Number(config.targetPage??1),imageCount:context.run.result?.images?.length??'',reviewInstruction},
    contract,
    data:{query:context.task.query,input:context.task.input,pageIndex:Number(config.targetPage??1),imageCount:context.run.result?.images?.length??0,...data},
    dataTag:'untrusted_image_edit_request',
  }));
}
function textEditPrompt(context,config,required,alreadyPresent,placementRegion) {
  return governedImageEditPrompt(context,config,{reviewInstruction:'人工生成标识',
    contract:internalPrompt('INTERNAL_EDIT_DISCLOSURE'),
    data:{operation:'AI_DISCLOSURE_LABEL',batchId:config.batchId??null,targetText:config.overlay.text,alreadyPresent,
      position:'bottom-right',targetRegion:placementRegion,
      textStyle:{textType:'AI_DISCLOSURE',font:'modern-sans-serif',fontSize:config.overlay.size,textColor:config.overlay.color,
        backgroundColor:config.overlay.background,backgroundShape:'solid-rounded-rectangle',opacity:config.overlay.opacity},
      mustPreserve:[...required,config.preserve].filter(Boolean),negative:config.negative},
  });
}
function aiEditPrompt(context,config,required) {
  if(config.operation==='AI_FUSION') {
    const appearanceReference=config.referenceMode==='APPEARANCE';
    const contract=appearanceReference
      ?internalPrompt('INTERNAL_EDIT_PRODUCT_APPEARANCE')
      :internalPrompt('INTERNAL_EDIT_PRODUCT_STRICT');
    return governedImageEditPrompt(context,config,{reviewInstruction:'真实产品替换',contract,
      data:{operation:'REAL_PRODUCT_REPLACEMENT',referenceMode:config.referenceMode??'STRICT',target:config.target,
        referenceProductDescription:config.referenceProductDescription??null,referencePurpose:config.references.map(r=>r.purpose),
        mustPreserve:[...required,config.preserve].filter(Boolean),negative:config.negative},
    });
  }
  if(config.operation==='AI_LOCAL') {
    const masked=config.mask!=null||config.localizedRegion!=null||config.localizedRegions!=null;
    const directMove=config.localMoveDirect===true;
    const repair=config.localRepair??null;
    const attachmentContract=repair
      ? internalPrompt('INTERNAL_EDIT_REPAIR_ATTACHMENTS')
      : directMove
      ? internalPrompt('INTERNAL_EDIT_MOVE_ATTACHMENTS')
      : '第一个附件是待编辑源图。';
    const directGuideContract=config.directMoveGuideAttached
      ? internalPrompt('INTERNAL_EDIT_MOVE_GUIDE')
      : '';
    const guideContract=config.roleGuideAttached
      ? internalPrompt('INTERNAL_EDIT_ROLE_GUIDE')
      : '';
    const removal=typeof config.removeDisclosure==='string'&&config.removeDisclosure;
    const mustPreserve=removal
      ? [...required,internalPrompt('INTERNAL_EDIT_REMOVE_PRESERVE')]
      : [...required,config.preserve].filter(Boolean);
    const negative=removal
      ? internalPrompt('INTERNAL_EDIT_REMOVE_NEGATIVE')
      : config.negative;
    return governedImageEditPrompt(context,config,{reviewInstruction:'局部修改',
      contract:directMove
        ? internalPrompt('INTERNAL_EDIT_MOVE_FULL_FRAME', { slot1: (attachmentContract), slot2: (directGuideContract), slot3: (repair?internalPrompt('INTERNAL_EDIT_MOVE_REPAIR'):'') })
        : masked
        ? internalPrompt('INTERNAL_EDIT_LOCAL_MASK', { slot1: (attachmentContract), slot2: (guideContract), slot3: (config.mask?'历史任务':'根据自然语言编辑规划生成'), slot4: (repair?internalPrompt('INTERNAL_EDIT_MASK_REPAIR'):''), slot5: (removal?internalPrompt('INTERNAL_EDIT_REMOVE_DISCLOSURE'):'不得新增、删除或改写已有文字。') })
        : internalPrompt('INTERNAL_EDIT_LOCAL_TEXT'),
      data:{operation:directMove?'LOCAL_MOVE_FULL_FRAME':masked?'LOCAL_MASK_EDIT':'LOCAL_PROMPT_EDIT',operatorInstruction:config.instruction,
        ...(masked?{mask:config.mask??(config.localizedRegions?{type:'regions',regions:config.localizedRegions}:{type:'rect',...config.localizedRegion})}:{}),
        ...(config.localPlan?{editPlan:{operationType:config.localPlan.operationType,targetDescription:config.localPlan.targetDescription,
          originalInstruction:config.localPlan.originalInstruction,
          sourceAction:config.localPlan.sourceAction,
          destinationAction:directMove?null:config.localPlan.destinationAction,
          quantity:directMove?null:config.localPlan.quantity,
          relationship:config.localPlan.relationship,sourceRegion:config.localPlan.sourceRegion,
          destinationRegion:directMove?null:config.localPlan.destinationRegion,
          contactRegion:directMove?null:config.localPlan.contactRegion,
          ...(directMove?{geometryPolicy:'自然语言中的目标关系与避让文字要求优先；旧坐标仅用于验收参考，不提供给生成模型'}:{})}}:{}),
        ...(repair?{repair:{attempt:repair.attempt,originalInstruction:repair.originalInstruction,
          failureCodes:repair.failureCodes,repairInstruction:repair.repairInstruction,repairRegions:repair.repairRegions}}:{}),
        attachmentRoles:{editTarget:'attachment-1',originalSourceReference:repair||directMove?'attachment-2':null,
          semanticRoleGuide:config.directMoveGuideAttached?'last':config.roleGuideAttached?'penultimate':null,binaryMask:masked?'last':null},
        ...(removal?{removeDisclosure:removal}:{}),mustPreserve,negative},
    });
  }
  return governedImageEditPrompt(context,config,{reviewInstruction:'历史整图修改',
    contract:internalPrompt('INTERNAL_EDIT_LEGACY_FULL'),
    data:{operation:config.operation,operatorInstruction:config.instruction,mustPreserve:[...required,config.preserve].filter(Boolean),negative:config.negative},
  });
}
const FUSION_SOURCE_TARGET_CHECKS=['descriptionMatches','exactlyOneTarget','wholeTargetInsideRegion','protectedContentExcluded'];
const FUSION_REFERENCE_CHECKS=['referenceUsable','referenceRecognizable','referencePrimaryProductClear'];
export function parseFusionTargetCheck(rawText,{referenceMode='STRICT'}={}) {
  const parsed=JSON.parse(rawText);
  const checks=parsed?.checks&&typeof parsed.checks==='object'&&!Array.isArray(parsed.checks)?parsed.checks:{};
  const confidence=typeof parsed?.confidence==='number'&&Number.isFinite(parsed.confidence)?parsed.confidence:0;
  const candidateCount=Number.isInteger(parsed?.candidateCount)?parsed.candidateCount:0;
  const referenceProductDescription=String(parsed?.referenceProductDescription??'').slice(0,500);
  const sourcePassed=confidence>=0.8&&candidateCount===1&&FUSION_SOURCE_TARGET_CHECKS.every(name=>checks[name]===true);
  const referencePassed=referenceMode==='APPEARANCE'
    ?checks.referenceRecognizable===true&&checks.referencePrimaryProductClear===true&&referenceProductDescription.trim().length>0
    :checks.referenceUsable===true;
  const passed=parsed?.passed===true&&sourcePassed&&referencePassed;
  const referenceWarnings=Array.isArray(parsed?.referenceWarnings)
    ?parsed.referenceWarnings.filter(item=>typeof item==='string').slice(0,10).map(item=>item.slice(0,300))
    :[];
  return {mode:'VISION_TARGET_REGION_CHECK',referenceMode,passed,sourcePassed,referencePassed,confidence,candidateCount,
    referenceProductDescription,referenceWarnings,
    checks:Object.fromEntries([...FUSION_SOURCE_TARGET_CHECKS,...FUSION_REFERENCE_CHECKS].map(name=>[name,checks[name]===true])),
    reason:String(parsed?.reason??'').slice(0,1000)};
}
async function validateFusionTarget(client,{inputPath,referencePaths,target,referenceMode='STRICT',signal}) {
  if(!target?.description||!target?.region) {
    throw Object.assign(new Error('旧版真实产品替换请求缺少目标描述或框选区域，请重新创建请求'),{
      nonBillablePreflightFailure:true,
      validation:{stage:'TARGET_LOCALIZATION',passed:false,billedImageGeneration:false,reason:'TARGET_REQUIRED'},
    });
  }
  const criteria=JSON.stringify({target,referenceMode}).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
  let response;
  try {
    response=await client.runVision({prompt:internalPrompt('INTERNAL_EDIT_TARGET_CHECK', { slot1: (criteria) }),
      inputPaths:[inputPath,...referencePaths],signal});
  } catch(error) {
    throw Object.assign(new Error('目标定位视觉服务失败，尚未调用图片编辑模型'),{
      cause:error,nonBillablePreflightFailure:true,
      validation:{stage:'TARGET_LOCALIZATION_SERVICE',passed:false,billedImageGeneration:false,
        code:String(error?.code??'VISION_SERVICE_FAILED').slice(0,100)},
    });
  }
  let check;
  try { check=parseFusionTargetCheck(response.rawText,{referenceMode}); }
  catch(error) {
    throw Object.assign(new Error('目标定位视觉结果格式无效，尚未调用图片编辑模型'),{
      cause:error,nonBillablePreflightFailure:true,
      validation:{stage:'TARGET_LOCALIZATION',passed:false,billedImageGeneration:false,reason:'INVALID_VISION_RESULT'},
    });
  }
  check.model=response.model??null;
  check.target=target;
  if(!check.passed) {
    const stage=check.sourcePassed?'REFERENCE_QUALITY':'TARGET_LOCALIZATION';
    throw Object.assign(new Error(`真实产品替换前置检查未通过，尚未调用图片编辑模型：${check.reason||'请调整目标选区或参考图使用方式'}`),{
      nonBillablePreflightFailure:true,
      validation:{stage,...check,billedImageGeneration:false},
    });
  }
  return check;
}
const LOCAL_PLAN_DECISIONS=new Set(['READY','SUGGEST','BLOCKED']);
const rectContains=(outer,inner)=>outer&&inner&&inner.x>=outer.x&&inner.y>=outer.y
  &&inner.x+inner.width<=outer.x+outer.width&&inner.y+inner.height<=outer.y+outer.height;
function localRect(value) {
  try{return safeRect(value);}catch{return null;}
}
function uniqueLocalRegions(values) {
  const regions=[];
  for(const value of values??[]) {
    const region=localRect(value);
    if(!region||region.width<24||region.height<24)continue;
    if(!regions.some(item=>JSON.stringify(item)===JSON.stringify(region)))regions.push(region);
  }
  return regions.slice(0,4);
}
function boundingRegion(regions) {
  if(!regions.length)return null;
  const x=Math.min(...regions.map(region=>region.x)),y=Math.min(...regions.map(region=>region.y));
  const right=Math.max(...regions.map(region=>region.x+region.width)),bottom=Math.max(...regions.map(region=>region.y+region.height));
  return {x,y,width:right-x,height:bottom-y};
}
const LOCAL_RESULT_FAILURE_CODES=new Set(['SOURCE_NOT_CLEARED','DESTINATION_OBJECT_MISSING','QUANTITY_INCORRECT',
  'POUR_CONTACT_MISSING','TARGET_COUNT_INCORRECT','PLACEMENT_OR_RELATIONSHIP_INCORRECT',
  'TARGET_INCOMPLETE_OR_OCCLUDED','COMPOSITION_UNBALANCED','REQUESTED_CHANGE_INCOMPLETE',
  'PROTECTED_TEXT_CHANGED','UNRELATED_CONTENT_CHANGED']);
const LOCAL_REPAIRABLE_FAILURE_CODES=new Set(['SOURCE_NOT_CLEARED','DESTINATION_OBJECT_MISSING','QUANTITY_INCORRECT',
  'POUR_CONTACT_MISSING','TARGET_COUNT_INCORRECT','PLACEMENT_OR_RELATIONSHIP_INCORRECT',
  'TARGET_INCOMPLETE_OR_OCCLUDED','COMPOSITION_UNBALANCED','REQUESTED_CHANGE_INCOMPLETE']);
const shortPlanText=value=>String(value??'').trim().slice(0,500);
function regionInsideAny(region,allowed) {
  return Boolean(region&&allowed.some(outer=>rectContains(outer,region)));
}
function normalizeRepairRegions(values,plan) {
  return uniqueLocalRegions(values).filter(region=>regionInsideAny(region,plan.editRegions??[]));
}
function derivedFailureCodes(checks) {
  const codes=[];
  if(!checks.requestedChangeCompleted)codes.push('REQUESTED_CHANGE_INCOMPLETE');
  if(!checks.targetCountCorrect)codes.push('TARGET_COUNT_INCORRECT');
  if(!checks.placementAndRepairNatural)codes.push('PLACEMENT_OR_RELATIONSHIP_INCORRECT');
  if(checks.movedTargetFullyVisible===false)codes.push('TARGET_INCOMPLETE_OR_OCCLUDED');
  if(checks.compositionBalanced===false)codes.push('COMPOSITION_UNBALANCED');
  if(!checks.protectedTextPreserved)codes.push('PROTECTED_TEXT_CHANGED');
  if(!checks.unrelatedContentPreserved)codes.push('UNRELATED_CONTENT_CHANGED');
  return codes;
}
function deriveRepairRegions(codes,plan) {
  const regions=[];
  const addContaining=region=>{for(const allowed of plan.editRegions??[])if(region&&rectContains(allowed,region))regions.push(allowed);};
  if(codes.includes('SOURCE_NOT_CLEARED'))addContaining(plan.sourceRegion);
  if(codes.some(code=>['DESTINATION_OBJECT_MISSING','QUANTITY_INCORRECT','POUR_CONTACT_MISSING',
    'TARGET_COUNT_INCORRECT','PLACEMENT_OR_RELATIONSHIP_INCORRECT','TARGET_INCOMPLETE_OR_OCCLUDED','COMPOSITION_UNBALANCED'].includes(code))) {
    addContaining(plan.destinationRegion);addContaining(plan.contactRegion);
  }
  if(!regions.length&&codes.includes('REQUESTED_CHANGE_INCOMPLETE')) {
    addContaining(plan.destinationRegion);addContaining(plan.contactRegion);
  }
  return uniqueLocalRegions(regions.length?regions:(plan.editRegions??[]));
}
async function renderLocalRoleGuide(plan,activeRegions) {
  const rectangles=[];
  const add=(regions,fill)=>{for(const region of regions??[])rectangles.push(`<rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="${fill}"/>`);};
  add(activeRegions,'#4b5563');add(plan.sourceRegion?[plan.sourceRegion]:[],'#ef4444');
  add(plan.destinationRegion?[plan.destinationRegion]:[],'#22c55e');add(plan.contactRegion?[plan.contactRegion]:[],'#3b82f6');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${EDIT_WIDTH}" height="${EDIT_HEIGHT}" viewBox="0 0 ${EDIT_WIDTH} ${EDIT_HEIGHT}"><rect width="100%" height="100%" fill="#000000"/>${rectangles.join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
function needsSoySpoonMoveGuide(plan) {
  return plan?.operationType==='MOVE'&&/加半勺老抽|老抽.*勺/u.test(plan.targetDescription??'');
}
async function renderSoySpoonMoveGuide(plan) {
  const bowlX=Math.round(EDIT_WIDTH*.77),bowlY=Math.round(EDIT_HEIGHT*.835);
  const handleX=Math.round(EDIT_WIDTH*.65),handleY=Math.round(EDIT_HEIGHT*.815);
  const streamX=Math.round(EDIT_WIDTH*.71),streamEndY=Math.round(EDIT_HEIGHT*.88);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${EDIT_WIDTH}" height="${EDIT_HEIGHT}" viewBox="0 0 ${EDIT_WIDTH} ${EDIT_HEIGHT}">
    <rect width="100%" height="100%" fill="#000000"/>
    <line x1="${handleX}" y1="${handleY}" x2="${bowlX-36}" y2="${bowlY-20}" stroke="#22c55e" stroke-width="26" stroke-linecap="round"/>
    <ellipse cx="${bowlX}" cy="${bowlY}" rx="60" ry="42" fill="none" stroke="#22c55e" stroke-width="14" transform="rotate(25 ${bowlX} ${bowlY})"/>
    <path d="M ${bowlX-12} ${bowlY+36} Q ${bowlX-28} ${bowlY+52}, ${streamX} ${streamEndY}" fill="none" stroke="#3b82f6" stroke-width="14" stroke-linecap="round"/>
    <circle cx="${streamX}" cy="${streamEndY}" r="21" fill="#3b82f6"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
function localMoveDirectInstruction(plan) {
  const flowRequired=/液流|倒入|流入|倾倒/u.test(`${plan.relationship??''}${plan.destinationAction??''}`);
  const estimatedPixelDistance=/\d+\s*(?:像素|px)/iu.test(`${plan.destinationAction??''}${plan.quantity??''}`)
    &&!/\d+\s*(?:像素|px)/iu.test(plan.originalInstruction??'');
  const soySpoonTask=/加半勺老抽|老抽.*勺/u.test(plan.targetDescription??'');
  const destination=plan.destinationRegion;
  const horizontalGuide=soySpoonTask
    ?internalPrompt('INTERNAL_EDIT_SOY_SPOON_GEOMETRY')
    :destination
    ?internalPrompt('INTERNAL_EDIT_DESTINATION_BAND', { slot1: (Math.round(destination.x/EDIT_WIDTH*100)), slot2: (Math.round((destination.x+destination.width)/EDIT_WIDTH*100)) })
    :'';
  const destinationAction=soySpoonTask
    ?internalPrompt('INTERNAL_EDIT_SOY_SPOON_DESTINATION')
    :estimatedPixelDistance
    ?`将该目标向${/左/u.test(plan.originalInstruction??'')?'左':'指定方向'}移动到不遮挡任何文字且能完成接触关系的自然位置`
    :plan.destinationAction||`将${plan.targetDescription||'目标对象'}移动到目标位置`;
  const quantity=estimatedPixelDistance
    ?String(plan.quantity??'').split(/[；;]/u).filter(part=>part&&!/\d+\s*(?:像素|px)/iu.test(part)).join('；')
    :plan.quantity;
  const source=plan.sourceRegion;
  const touchedRight=Boolean(source&&source.x+source.width>=EDIT_WIDTH);
  const touchedBottom=Boolean(source&&source.y+source.height>=EDIT_HEIGHT);
  const spoonGuide=/勺/u.test(plan.targetDescription??'')
    ?internalPrompt('INTERNAL_EDIT_SPOON_VISIBILITY', { slot1: (soySpoonTask?'并严格按上述勺碗中心、勺柄端安全带落位':'或上方') })
    :'';
  const soySpoonProtection=soySpoonTask
    ?internalPrompt('INTERNAL_EDIT_SOY_SPOON_PROTECTION')
    :'';
  const edgeGuide=touchedRight||touchedBottom
    ?internalPrompt('INTERNAL_EDIT_EDGE_CLEARANCE', { slot1: (touchedRight?'贴住右边缘':''), slot2: (touchedRight&&touchedBottom?'且':''), slot3: (touchedBottom?'贴住下边缘':'') })
    :'';
  return internalPrompt('INTERNAL_EDIT_MOVE_INSTRUCTION', { slot1: (plan.targetDescription||'任务明确点名的目标对象'), slot2: (soySpoonProtection), slot3: (destinationAction), slot4: (horizontalGuide), slot5: (spoonGuide), slot6: (edgeGuide), slot7: (quantity?`数量或容量要求：${quantity}。`:''), slot8: (estimatedPixelDistance?'原始说明没有要求精确像素，已忽略规划器自行估算的像素距离。':''), slot9: (plan.relationship?`必须形成的关系：${plan.relationship}。`:''), slot10: (flowRequired?internalPrompt('INTERNAL_EDIT_FLOW_CONTACT'):''), slot11: (plan.sourceAction||'彻底移除原位置对象及其痕迹并自然修复背景') });
}
export function parseLocalTargetCheck(rawText) {
  const parsed=JSON.parse(rawText);
  const checks=parsed?.checks&&typeof parsed.checks==='object'&&!Array.isArray(parsed.checks)?parsed.checks:{};
  const confidence=typeof parsed?.confidence==='number'&&Number.isFinite(parsed.confidence)?parsed.confidence:0;
  const candidateCount=Number.isInteger(parsed?.candidateCount)?parsed.candidateCount:0;
  const sourceRegion=localRect(parsed?.sourceRegion??parsed?.region);
  const destinationRegion=localRect(parsed?.destinationRegion);
  let editRegions=uniqueLocalRegions(parsed?.editRegions);
  if(!editRegions.length)editRegions=uniqueLocalRegions([parsed?.editRegion,sourceRegion,destinationRegion]);
  const wholeVisibleTargetInsideRegion=checks.wholeVisibleTargetInsideRegion===true
    ||(checks.wholeVisibleTargetInsideRegion==null&&checks.wholeTargetInsideRegion===true);
  const protectedTextExcluded=checks.protectedTextExcluded===true;
  const editRegionSafe=checks.editRegionSafe===true||(checks.editRegionSafe==null&&protectedTextExcluded);
  const missingPartsRequiredForEdit=parsed?.missingPartsRequiredForEdit===true;
  const sourceCovered=sourceRegion!==null&&editRegions.some(region=>rectContains(region,sourceRegion));
  const destinationCovered=destinationRegion===null||editRegions.some(region=>rectContains(region,destinationRegion));
  const explicitDecision=String(parsed?.decision??'').toUpperCase();
  const decision=LOCAL_PLAN_DECISIONS.has(explicitDecision)?explicitDecision:(parsed?.passed===true?'READY':'BLOCKED');
  const suggestedInstruction=String(parsed?.suggestedInstruction??'').trim().slice(0,2000);
  const contactCandidate=localRect(parsed?.contactRegion);
  const contactRegion=regionInsideAny(contactCandidate,editRegions)?contactCandidate:null;
  const baseSafe=confidence>=0.8&&candidateCount===1&&sourceRegion!==null&&editRegions.length>0
    &&sourceCovered&&destinationCovered&&!missingPartsRequiredForEdit
    &&checks.instructionSpecific===true&&checks.exactlyOneTarget===true&&wholeVisibleTargetInsideRegion
    &&protectedTextExcluded&&editRegionSafe;
  const canEdit=baseSafe&&decision!=='BLOCKED'&&(decision!=='SUGGEST'||suggestedInstruction.length>0);
  const passed=canEdit&&decision==='READY'&&parsed?.passed!==false;
  const touchesImageEdge=parsed?.touchesImageEdge===true||Boolean(sourceRegion&&(sourceRegion.x===0||sourceRegion.y===0
    ||sourceRegion.x+sourceRegion.width===EDIT_WIDTH||sourceRegion.y+sourceRegion.height===EDIT_HEIGHT));
  const normalizedChecks={instructionSpecific:checks.instructionSpecific===true,exactlyOneTarget:checks.exactlyOneTarget===true,
    wholeVisibleTargetInsideRegion,protectedTextExcluded,editRegionSafe};
  return {mode:'VISION_PROMPT_REGION_CHECK',decision,canEdit,passed,confidence,candidateCount,
    region:sourceRegion,sourceRegion,destinationRegion,editRegion:boundingRegion(editRegions),editRegions,touchesImageEdge,
    missingPartsRequiredForEdit,operationType:String(parsed?.operationType??'ADJUST').slice(0,50),suggestedInstruction,
    sourceAction:shortPlanText(parsed?.sourceAction),destinationAction:shortPlanText(parsed?.destinationAction),
    quantity:shortPlanText(parsed?.quantity),relationship:shortPlanText(parsed?.relationship),contactRegion,
    warnings:Array.isArray(parsed?.warnings)?parsed.warnings.filter(value=>typeof value==='string').slice(0,8).map(value=>value.slice(0,300)):[],
    targetIsAiDisclosure:parsed?.targetIsAiDisclosure===true,
    targetDescription:String(parsed?.targetDescription??'').slice(0,500),
    checks:{...normalizedChecks,wholeTargetInsideRegion:checks.wholeTargetInsideRegion===true},
    reason:String(parsed?.reason??'').slice(0,1000)};
}
async function validateLocalTarget(client,{inputPath,instruction,signal}) {
  const criteria=JSON.stringify({instruction}).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
  let response;
  try {
    response=await client.runVision({prompt:internalPrompt('INTERNAL_EDIT_LOCAL_PLAN', { slot1: (criteria) }),
      inputPaths:[inputPath],signal});
  } catch(error) {
    throw Object.assign(new Error('自然语言目标定位视觉服务失败，尚未调用图片编辑模型'),{
      cause:error,nonBillablePreflightFailure:true,
      validation:{stage:'LOCAL_TARGET_LOCALIZATION_SERVICE',passed:false,billedImageGeneration:false,
        code:String(error?.code??'VISION_SERVICE_FAILED').slice(0,100)},
    });
  }
  let check;
  try{check=parseLocalTargetCheck(response.rawText);}catch(error){
    throw Object.assign(new Error('自然语言目标定位结果格式无效，尚未调用图片编辑模型'),{
      cause:error,nonBillablePreflightFailure:true,
      validation:{stage:'LOCAL_TARGET_LOCALIZATION',passed:false,billedImageGeneration:false,reason:'INVALID_VISION_RESULT'},
    });
  }
  check.model=response.model??null;
  check.instruction=instruction;
  if(check.decision==='SUGGEST'&&check.canEdit)throw Object.assign(new Error('已生成更适合图片编辑的描述，请确认采用后再调用图片编辑模型'),{
    nonBillablePreflightFailure:true,
    validation:{stage:'LOCAL_EDIT_SUGGESTION',...check,billedImageGeneration:false},
  });
  if(!check.passed)throw Object.assign(new Error(`局部修改规划未通过，尚未调用图片编辑模型：${check.reason||'请补充目标位置、外观特征或修改后的目标位置'}`),{
    nonBillablePreflightFailure:true,
    validation:{stage:'LOCAL_TARGET_LOCALIZATION',...check,billedImageGeneration:false},
  });
  return check;
}
function acceptedLocalPlan(config) {
  const plan=config?.localPlan;
  if(!plan||typeof plan!=='object'||Array.isArray(plan)||plan.accepted!==true)return null;
  const suggestedInstruction=String(plan.suggestedInstruction??'').slice(0,2000);
  if(!suggestedInstruction||suggestedInstruction!==String(config.instruction??''))throw new Error('已采用的局部修改描述与规划不一致，请重新创建请求');
  const sourceRegion=localRect(plan.sourceRegion??plan.region);
  const destinationRegion=localRect(plan.destinationRegion);
  const editRegions=uniqueLocalRegions(plan.editRegions);
  if(!sourceRegion||!editRegions.length||!editRegions.some(region=>rectContains(region,sourceRegion))
    ||(destinationRegion&&!editRegions.some(region=>rectContains(region,destinationRegion))))throw new Error('已采用的局部修改规划无效，请重新创建请求');
  return {mode:'VISION_PROMPT_REGION_CHECK',decision:'READY',canEdit:true,passed:true,adoptedSuggestion:true,
    confidence:typeof plan.confidence==='number'?plan.confidence:1,candidateCount:1,region:sourceRegion,sourceRegion,destinationRegion,
    editRegion:boundingRegion(editRegions),editRegions,touchesImageEdge:plan.touchesImageEdge===true,
    missingPartsRequiredForEdit:false,operationType:String(plan.operationType??'ADJUST').slice(0,50),
    originalInstruction:String(plan.originalInstruction??'').slice(0,2000),suggestedInstruction,
    sourceAction:shortPlanText(plan.sourceAction),destinationAction:shortPlanText(plan.destinationAction),
    quantity:shortPlanText(plan.quantity),relationship:shortPlanText(plan.relationship),
    contactRegion:regionInsideAny(localRect(plan.contactRegion),editRegions)?localRect(plan.contactRegion):null,
    warnings:Array.isArray(plan.warnings)?plan.warnings.filter(value=>typeof value==='string').slice(0,8).map(value=>value.slice(0,300)):[],
    targetIsAiDisclosure:plan.targetIsAiDisclosure===true,targetDescription:String(plan.targetDescription??'').slice(0,500),
    checks:{instructionSpecific:true,exactlyOneTarget:true,wholeVisibleTargetInsideRegion:true,
      protectedTextExcluded:true,editRegionSafe:true,wholeTargetInsideRegion:plan.checks?.wholeTargetInsideRegion===true},
    reason:String(plan.reason??'已由作业员采用视觉模型建议').slice(0,1000),model:plan.model??null};
}
function repairedLocalPlan(config) {
  const repair=config?.localRepair,plan=repair?.plan;
  if(!repair||!plan||typeof plan!=='object'||Array.isArray(plan))return null;
  const sourceRegion=localRect(plan.sourceRegion??plan.region),destinationRegion=localRect(plan.destinationRegion);
  const editRegions=uniqueLocalRegions(plan.editRegions);
  if(!sourceRegion||!editRegions.length||!editRegions.some(region=>rectContains(region,sourceRegion))) {
    throw new Error('失败预览的局部修复规划无效，请从原图重新创建请求');
  }
  const contactRegion=regionInsideAny(localRect(plan.contactRegion),editRegions)?localRect(plan.contactRegion):null;
  return {mode:'VISION_PROMPT_REGION_CHECK',decision:'READY',canEdit:true,passed:true,rejectedPreviewRepair:true,
    confidence:typeof plan.confidence==='number'?plan.confidence:1,candidateCount:1,region:sourceRegion,sourceRegion,destinationRegion,
    editRegion:boundingRegion(editRegions),editRegions,touchesImageEdge:plan.touchesImageEdge===true,
    missingPartsRequiredForEdit:false,operationType:String(plan.operationType??'ADJUST').slice(0,50),
    originalInstruction:String(repair.originalInstruction??config.instruction??'').slice(0,2000),
    suggestedInstruction:String(config.instruction??'').slice(0,2000),sourceAction:shortPlanText(plan.sourceAction),
    destinationAction:shortPlanText(plan.destinationAction),quantity:shortPlanText(plan.quantity),
    relationship:shortPlanText(plan.relationship),contactRegion,targetIsAiDisclosure:plan.targetIsAiDisclosure===true,
    targetDescription:String(plan.targetDescription??'').slice(0,500),warnings:Array.isArray(plan.warnings)?plan.warnings.slice(0,8):[],
    checks:{instructionSpecific:true,exactlyOneTarget:true,wholeVisibleTargetInsideRegion:true,
      protectedTextExcluded:true,editRegionSafe:true,wholeTargetInsideRegion:plan.checks?.wholeTargetInsideRegion===true},
    reason:String(plan.reason??'基于失败预览定向修复').slice(0,1000),model:plan.model??null};
}
const LOCAL_RESULT_CHECKS=['requestedChangeCompleted','targetCountCorrect','placementAndRepairNatural','protectedTextPreserved','unrelatedContentPreserved'];
async function validateLocalEditResult(client,{inputPath,originalInputPath,outputPath,instruction,plan,repair,signal}) {
  const estimatedPixelDistance=/\d+\s*(?:像素|px)/iu.test(`${plan.destinationAction??''}${plan.quantity??''}`)
    &&!/\d+\s*(?:像素|px)/iu.test(plan.originalInstruction??'');
  const semanticSoySpoonMove=plan.operationType==='MOVE'&&/加半勺老抽|老抽.*勺/u.test(plan.targetDescription??'');
  const discardPlannerGeometry=estimatedPixelDistance||semanticSoySpoonMove;
  const semanticQuantity=estimatedPixelDistance
    ?String(plan.quantity??'').split(/[；;]/u).filter(part=>part&&!/\d+\s*(?:像素|px)/iu.test(part)).join('；')
    :plan.quantity;
  const criteria=JSON.stringify({instruction,originalInstruction:plan.originalInstruction??instruction,operationType:plan.operationType,targetDescription:plan.targetDescription,
    sourceAction:plan.sourceAction,destinationAction:discardPlannerGeometry?null:plan.destinationAction,quantity:semanticQuantity,relationship:plan.relationship,
    sourceRegion:plan.sourceRegion,destinationRegion:discardPlannerGeometry?null:plan.destinationRegion,contactRegion:discardPlannerGeometry?null:plan.contactRegion,
    ...(discardPlannerGeometry?{discardedPlannerConstraint:semanticSoySpoonMove
      ?'本任务使用最终语义构图规则；规划器早期估算的目标框、接触框和移动距离不得用于判定'
      :'用户未要求精确像素；规划器自行估算的像素距离和冲突坐标不得用于判定'}:{}),
    editRegions:plan.editRegions,warnings:plan.warnings,repair:repair?{failureCodes:repair.failureCodes,
      repairInstruction:repair.repairInstruction,repairRegions:repair.repairRegions}:null})
    .replaceAll('<','\\u003c').replaceAll('>','\\u003e');
  const repairMode=Boolean(repair&&originalInputPath);
  let response;
  try {
    response=await client.runVision({prompt:internalPrompt('INTERNAL_EDIT_LOCAL_REVIEW', { slot1: (repairMode?internalPrompt('INTERNAL_EDIT_REVIEW_ATTACHMENTS'):'第一个附件是编辑前源图，第二个附件是编辑结果。'), slot2: (criteria) }),
      inputPaths:repairMode?[originalInputPath,inputPath,outputPath]:[inputPath,outputPath],signal});
  } catch(error) {
    throw Object.assign(new Error('局部修改结果视觉验收服务失败，图片编辑模型已经调用'),{cause:error,
      validation:{stage:'LOCAL_EDIT_RESULT_SERVICE',passed:false,billedImageGeneration:true,
        code:String(error?.code??'VISION_SERVICE_FAILED').slice(0,100)}});
  }
  let parsed;
  try{parsed=JSON.parse(response.rawText);}catch(error){
    throw Object.assign(new Error('局部修改结果视觉验收格式无效，图片编辑模型已经调用'),{cause:error,
      validation:{stage:'LOCAL_EDIT_RESULT',passed:false,billedImageGeneration:true,reason:'INVALID_VISION_RESULT'}});
  }
  const checks=parsed?.checks&&typeof parsed.checks==='object'&&!Array.isArray(parsed.checks)?parsed.checks:{};
  const requiredChecks=plan.operationType==='MOVE'?[...LOCAL_RESULT_CHECKS,'movedTargetFullyVisible','compositionBalanced']:LOCAL_RESULT_CHECKS;
  const passed=parsed?.passed===true&&requiredChecks.every(name=>checks[name]===true);
  const normalizedChecks=Object.fromEntries(requiredChecks.map(name=>[name,checks[name]===true]));
  let failureCodes=Array.isArray(parsed?.failureCodes)
    ? [...new Set(parsed.failureCodes.filter(code=>typeof code==='string'&&LOCAL_RESULT_FAILURE_CODES.has(code)))]
    : [];
  if(!passed&&!failureCodes.length)failureCodes=derivedFailureCodes(normalizedChecks);
  let repairRegions=normalizeRepairRegions(parsed?.repairRegions,plan);
  if(!passed&&!repairRegions.length)repairRegions=deriveRepairRegions(failureCodes,plan);
  const repairInstruction=String(parsed?.repairInstruction??'').trim().slice(0,2000)
    ||(!passed?`只修复以下未完成项：${String(parsed?.reason??'任务未完整完成').slice(0,1000)}。完整目标仍为：${instruction}`:'');
  const repairableFromRejected=!passed&&normalizedChecks.protectedTextPreserved&&normalizedChecks.unrelatedContentPreserved
    &&failureCodes.length>0&&failureCodes.every(code=>LOCAL_REPAIRABLE_FAILURE_CODES.has(code))&&repairRegions.length>0;
  return {mode:'VISION_LOCAL_EDIT_RESULT_CHECK',passed,
    checks:normalizedChecks,failureCodes,repairInstruction,repairRegions,repairableFromRejected,
    reason:String(parsed?.reason??'').slice(0,1000),model:response.model??null};
}
async function exactComposite(source,refs,config) {
  const layers=[];
  for(const r of [...config.references].sort((a,b)=>a.z-b.z)) {
    const bytes=refs.find(ref=>Number(ref.asset.id)===r.assetId)?.bytes;
    let pipeline=sharp(bytes,{limitInputPixels:16_000_000});
    if(r.crop) pipeline=pipeline.extract({left:r.crop.x,top:r.crop.y,width:r.crop.width,height:r.crop.height});
    const {data,info}=await pipeline.resize(r.width,r.height,{fit:'fill'}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    // Optional deterministic white-background removal; never invents hidden pixels.
    for(let i=0;i<data.length;i+=4) data[i+3]=r.removeBackground&&data[i]>245&&data[i+1]>245&&data[i+2]>245?0:Math.round(data[i+3]*r.opacity);
    layers.push({input:await sharp(data,{raw:info}).png().toBuffer(),left:r.x,top:r.y});
  }
  return sharp(source).composite(layers).png().toBuffer();
}
function pageText(context,pageIndex) {
  const visual=context.run.result?.visualPlan?.value?.pages?.[pageIndex-1]?.allowedVisibleText;
  const content=context.revision.content;
  const page=(content.imagePlan??content.reviewed?.imagePlan??content.post?.imagePlan)?.[pageIndex-1];
  if(!page) throw new Error('缺少已批准的页面文案');
  const plan=visual??page;
  return [plan.headline,plan.subtitle,...(plan.bullets??[]),...(plan.labels??[]),...(context.run.result.images?.[pageIndex-1]?.imageEditRequiredText??[])].filter(t=>typeof t==='string'&&t.trim());
}
function visionAlignmentInput(context,pageIndex,required,overlay=null) {
  const content=context.revision.content;
  const pages=content.imagePlan??content.reviewed?.imagePlan??content.post?.imagePlan;
  const page=pages?.[pageIndex-1];
  if(!page||typeof page!=='object')throw new Error('缺少已批准的页面文案');
  const stored=context.run.result?.visualPlan?.value?.pages?.[pageIndex-1]
    ??context.run.result?.visualPlan?.pages?.[pageIndex-1]??{};
  const raw=stored.allowedVisibleText??page;
  const includes=value=>typeof value==='string'&&required.some(item=>cleanText(item)===cleanText(value));
  const headline=includes(raw.headline)?raw.headline:'',subtitle=includes(raw.subtitle)?raw.subtitle:'';
  const bullets=(raw.bullets??[]).filter(includes),baseLabels=(raw.labels??[]).filter(includes);
  const classified=[headline,subtitle,...bullets,...baseLabels].filter(Boolean);
  const labels=[...baseLabels,...required.filter(value=>!classified.some(item=>cleanText(item)===cleanText(value)))];
  const placement=overlay?internalPrompt('INTERNAL_EDIT_DISCLOSURE_CHECK', { slot1: (overlay.text), slot2: (overlay.textType), slot3: (overlay.position), slot4: (overlay.x), slot5: (overlay.y), slot6: (overlay.width), slot7: (overlay.height), slot8: (overlay.size), slot9: (overlay.color), slot10: (overlay.background) }):'';
  const copy=content.copy??content.reviewed?.post??content.post??{};
  return {
    post:{title:String(copy.title??headline??''),body:String(copy.body??''),tags:Array.isArray(copy.tags)?copy.tags:[]},
    imageCount:pages.length,
    visualPage:{...stored,kind:stored.kind??page.kind??'detail',visualSubject:stored.visualSubject??'保持当前图片既有主体与构图',
      sourceEvidence:stored.sourceEvidence??'以当前图片和已批准文案为准',
      layoutDirection:[stored.layoutDirection,placement].filter(Boolean).join('；')||'保持当前图片既有版式',
      mustShow:[...(stored.mustShow??[]),...(placement?[placement]:[])],
      allowedVisibleText:{language:'zh-CN',headline,subtitle,bullets,labels:[...new Set(labels)]}},
  };
}
async function validateWithExistingVision({client,context,imagePath,pageIndex,attempt,requiredText,overlay}) {
  const input=visionAlignmentInput(context,pageIndex,requiredText,overlay);
  const validator=createImageAlignmentValidator({agentClient:client,post:input.post,visualPage:input.visualPage,imageCount:input.imageCount});
  return validator({imagePath,pageIndex,attempt});
}
function visionTextCheck(alignment,targetText=null,placement=null,{ocrOnly=false}={}) {
  const fields=alignment?.recognizedText??{headline:'',subtitle:'',bullets:[],otherText:[]};
  const recognizedText=[fields.headline,fields.subtitle,...(fields.bullets??[]),...(fields.otherText??[])].join('');
  const targetOccurrences=targetText?occurrences(recognizedText,targetText):undefined;
  const missing=alignment?.ocrMismatches??['visionResult'];
  const uncertain=[...(alignment?.unreadableText??[]),...(Number(alignment?.ocrConfidence)<0.9?['ocrConfidence']:[])];
  const extra=missing.includes('otherText')?['otherText']:[];
  const requested=placement?{x:placement.x,y:placement.y,width:placement.width,height:placement.height}:null;
  const style=placement?{
    textType:placement.textType,font:'modern-sans-serif',fontSize:placement.size,textColor:placement.color,
    backgroundColor:placement.background,backgroundShape:'solid-rounded-rectangle',opacity:placement.opacity}:null;
  const placementPassed=placement?targetOccurrences===1:true;
  const placementCheck=requested?{passed:placementPassed,
    requested:{position:placement.position,...requested},style,
    mode:'MODEL_GENERATED_DISCLOSURE',layoutMatched:alignment?.layoutMatched===true}:null;
  if(ocrOnly) {
    const hardPassed=missing.length===0&&uncertain.length===0;
    const warnings=[];
    if(alignment?.styleMatched===false)warnings.push('视觉模型认为源图样式仍可调整');
    if(alignment?.layoutMatched===false)warnings.push('视觉模型认为源图布局仍可调整');
    for(const value of alignment?.contradictions??[])warnings.push(value);
    return {...alignment,passed:hardPassed,failureClass:hardPassed?'PASS':alignment?.failureClass,
      repairInstruction:hardPassed?'':alignment?.repairInstruction,engine:'existing-vision-ocr-precheck',
      recognizedFields:fields,recognizedText,targetOccurrences,placement:placementCheck,missing,extra,uncertain,
      visualAdvisory:{passed:warnings.length===0,warnings,styleMatched:alignment?.styleMatched===true,
        layoutMatched:alignment?.layoutMatched===true,modelFailureClass:alignment?.modelAssessment?.failureClass??alignment?.failureClass??null},
      programAssessment:{...(alignment?.programAssessment??{}),passed:hardPassed,failureClass:hardPassed?'PASS':alignment?.failureClass,
        reason:'源图必需文字和可读性为硬门槛；视觉样式与布局结论仅作提示'}};
  }
  if(placement) {
    const hardPassed=targetOccurrences===1&&missing.length===0&&uncertain.length===0;
    const warnings=[];
    if(alignment?.styleMatched===false)warnings.push('视觉模型认为标识样式与画面不完全一致');
    if(alignment?.layoutMatched===false)warnings.push('视觉模型认为标识布局仍可调整');
    for(const value of alignment?.contradictions??[])warnings.push(value);
    return {...alignment,passed:hardPassed,failureClass:hardPassed?'PASS':alignment?.failureClass,
      repairInstruction:hardPassed?'':alignment?.repairInstruction,engine:'model-generated-disclosure-with-vision-ocr',
      recognizedFields:fields,recognizedText,targetOccurrences,placement:placementCheck,missing,extra,uncertain,
      visualAdvisory:{passed:warnings.length===0,warnings,styleMatched:alignment?.styleMatched===true,
        layoutMatched:alignment?.layoutMatched===true,modelFailureClass:alignment?.modelAssessment?.failureClass??alignment?.failureClass??null},
      programAssessment:{...(alignment?.programAssessment??{}),passed:hardPassed,failureClass:hardPassed?'PASS':alignment?.failureClass,
        reason:'标识文字、出现次数和可读性为硬门槛；目标区域只用于校验标识位置，不作为编辑蒙版；视觉样式与细微布局结论仅作提示'}};
  }
  return {...alignment,passed:alignment?.passed===true,engine:'existing-vision-alignment',
    recognizedFields:fields,recognizedText,targetOccurrences,placement:placementCheck,missing,extra,uncertain};
}
export async function processImageEdit({service,storageRoot,workerId,edit=null,signal,environment=process.env,agentClient,validateImage,mock=false,maxGenerationAttempts}) {
  if(maxGenerationAttempts!==undefined&&maxGenerationAttempts!==1) throw new TypeError('图片修改仅允许单次生成');
  if(validateImage!==undefined&&typeof validateImage!=='function')throw new TypeError('图片视觉验收器无效');
  const e=edit??await service.claim(workerId);
  if(!e)return {status:'idle'};
  const directory=resolve(storageRoot,'image-edit-work',String(Number(e.task_id)),randomUUID());
  let lostLease=false;
  let imageModelRequested=false;
  let failedPreviewBytes=null;
  const controller=new AbortController();
  let alignmentStage='SOURCE';
  const stop=(reason=new Error('图片编辑租约失效或已取消'))=>{lostLease=true;if(!controller.signal.aborted)controller.abort(reason);};
  const externalAbort=()=>stop(signal.reason);
  if(signal?.aborted)externalAbort();else signal?.addEventListener('abort',externalAbort,{once:true});
  const heartbeat=setInterval(()=>{void service.heartbeat(e).then(ok=>{if(!ok)stop();}).catch(stop);},30_000);
  try {
    const context=await service.context(e),config=e.config;
    const frozenPrompt = config.imageEditPrompt ?? context.imageEditPrompt;
    const runtime = frozenPrompt?.runtime ?? { source: 'LEGACY_IMAGE_EDIT_REQUEST', settings: null,
      prompts: frozenPrompt?.content ? { IMAGE_EDIT_SYSTEM: frozenPrompt } : {} };
    return await withPromptRuntime(runtime, async () => {
    await mkdir(directory,{recursive:true});
    const originalSource=await service.readAsset(context.source);
    if(config.localRepair&&!context.repairSource)throw new Error('失败预览修复源缺失，请从原图重新创建请求');
    let source=config.localRepair?await service.readAsset(context.repairSource):originalSource;
    if(e.operation==='RESTORE') {
      const restoredId=context.restored.result.images?.[e.target_page-1]?.deliveryAssetId??context.restored.result.images?.[e.target_page-1]?.assetId;
      if(!Number.isSafeInteger(restoredId))throw new Error('历史图集不完整');
      source=await service.readAsset(await service.asset(restoredId,Number(e.task_id)));
    }
    const metadata=await sharp(source).metadata();
    if(metadata.width!==EDIT_WIDTH||metadata.height!==EDIT_HEIGHT)throw new Error('仅可编辑 1086×1448 交付图');
    const inputPath=resolve(directory,'source.png'),outputPath=resolve(directory,'result.png');
    await writeFile(inputPath,source);
    const originalInputPath=config.localRepair?resolve(directory,'original-source.png'):null;
    if(originalInputPath)await writeFile(originalInputPath,originalSource);
    const validationContext=context.restored?{...context,run:context.restored}:context;
    const pageRequired=[...new Set(pageText(validationContext,e.target_page))];
    const inheritedDisclosure=imagePageDisclosure(validationContext.run.result,Number(e.target_page));
    const currentImage=validationContext.run.result?.images?.[Number(e.target_page)-1];
    const generatedDisclosure=typeof currentImage?.complianceDisclosure==='string'&&currentImage.complianceDisclosure.trim()
      ?{type:'AI_GENERATED',text:currentImage.complianceDisclosure.trim()}:null;
    if(e.operation==='SVG_DISCLOSURE') {
      const existingDisclosure=inheritedDisclosure??generatedDisclosure;
      if(existingDisclosure)throw Object.assign(new Error(`当前图片已有人工生成标识“${existingDisclosure.text}”，请勿重复添加`),{
        validation:{stage:'PROGRAMMATIC_DISCLOSURE',passed:false,billedImageGeneration:false,reason:'DISCLOSURE_ALREADY_PRESENT',
          disclosure:{required:existingDisclosure.text,added:existingDisclosure}},
      });
      const targetText=config.overlay.text;
      const storedStyle=currentImage?.aiDisclosureStyle;
      const visualPlan=validationContext.run.result?.visualPlan?.value??validationContext.run.result?.visualPlan;
      const visualStyle=typeof storedStyle?.color==='string'
        ?{disclosureColor:storedStyle.color}
        :resolveAiDisclosureVisualStyle(visualPlan);
      const style=createAiDisclosureStyle({text:targetText,visualStyle});
      const svg=aiDisclosureBadgeSvg({text:targetText,visualStyle});
      const result=await sharp(source,{limitInputPixels:16_000_000})
        .composite([{input:Buffer.from(svg,'utf8'),top:0,left:0}]).png().toBuffer();
      const mask=await renderRegionsMask([{x:style.x,y:style.y,width:style.width,height:style.height}]);
      const outsideMask=await assertOutsideMask(source,result,mask);
      const finalMetadata=await sharp(result).metadata();
      const required=[...new Set([...pageRequired,targetText])];
      const placement={passed:true,mode:'PROGRAMMATIC_SVG_DISCLOSURE',requested:{position:style.position,
        x:style.x,y:style.y,width:style.width,height:style.height},style};
      const text={passed:true,engine:'sharp-svg-disclosure',recognizedText:targetText,targetOccurrences:1,
        placement,missing:[],extra:[],uncertain:[],programAssessment:{passed:true,failureClass:'PASS',
          reason:'标识文字由受控 SVG 转义后使用 Sharp 确定性合成，标识区域外像素已逐像素校验未改变'}};
      const validation={passed:finalMetadata.width===EDIT_WIDTH&&finalMetadata.height===EDIT_HEIGHT&&finalMetadata.format==='png',
        mock,billedImageGeneration:false,restoredPages:[],dimensions:{passed:finalMetadata.width===EDIT_WIDTH&&finalMetadata.height===EDIT_HEIGHT,
          width:finalMetadata.width,height:finalMetadata.height},format:finalMetadata.format,text,requiredText:required,
        disclosure:{required:targetText,added:{type:'AI_GENERATED',text:targetText}},integrity:{sha256:imageHash(result)},outsideMask,
        localization:null,entityConsistency:{mode:'NOT_APPLICABLE',passed:true},localConsistency:{mode:'NOT_APPLICABLE',passed:true},
        model:null,generationAttempts:0,repairAttempt:0,repairMaxAttempts:0,prompt:null,
        renderer:{engine:'sharp-svg',badgeVersion:style.version,style}};
      if(!validation.passed)throw Object.assign(new Error('程序生成标识的尺寸或格式校验失败'),{validation});
      await writeFile(outputPath,result);
      if(lostLease)throw new Error('执行租约失效');
      return {status:'PREVIEW_READY',...await service.complete(e,{bytes:result,mask,validation})};
    }
    const client=agentClient??(validateImage?null:createAgentClient({modelApi:context.settings.modelApi,environment}));
    const verify=input=>validateImage?validateImage(input):validateWithExistingVision({client,...input});
    const inheritedDisclosureText=inheritedDisclosure?.text??'';
    // A production default describes what a newly requested disclosure should
    // contain; it is not evidence that every page in an existing image set
    // already contains that text. Only page-scoped lineage may make disclosure
    // text mandatory during source validation.
    const sourceDisclosure=inheritedDisclosureText;
    const sourceRequired=[...new Set([...pageRequired,...(sourceDisclosure?[sourceDisclosure]:[])])];
    const targetText=e.operation==='TEXT'?config.overlay.text:null;
    let required=e.operation==='TEXT'
      ? [...new Set([...sourceRequired.filter(text=>cleanText(text)!==cleanText(sourceDisclosure)&&cleanText(text)!==cleanText(targetText)),targetText])]
      : sourceRequired;
    let disclosure=targetText??sourceDisclosure;
    const sourceChecks=[];
    let originalCheck=null;
    for(let sourceAttempt=1;sourceAttempt<=2;sourceAttempt++) {
      const beforeAlignment=await verify({context:validationContext,imagePath:inputPath,pageIndex:Number(e.target_page),attempt:sourceAttempt-1,requiredText:sourceRequired,overlay:null});
      originalCheck=visionTextCheck(beforeAlignment,null,null,{ocrOnly:e.operation==='TEXT'});
      sourceChecks.push(originalCheck);
      if(originalCheck.passed)break;
    }
    if(!originalCheck?.passed)throw Object.assign(new Error('源图视觉验收不确定或必需文字缺失，不能安全编辑'),{validation:{stage:'SOURCE',passed:false,checks:sourceChecks}});
    alignmentStage='RESULT';
    const refs=[];
    for(const asset of context.refs)refs.push({asset,bytes:await service.readAsset(asset)});
    let result=source,mask=null,outsideMask=null,targetLocalization=null,directLocalMove=false,directMoveGuideAttached=false,localExecutionInstruction=config.instruction,entityConsistency={mode:'NOT_APPLICABLE',passed:true},
      localConsistency={mode:'NOT_APPLICABLE',passed:true},model=null,generationAttempts=0,textCheck=null;
    let removedInheritedDisclosure=false;
    if(e.operation==='TEXT') {
      if(mock) throw new Error('mock 不生成可采用的 AI 编辑结果');
      const placement={...config.overlay,...disclosurePlacementRegion(config.overlay)};
      const basePrompt=textEditPrompt(context,{...config,targetPage:Number(e.target_page)},required,
        occurrences(originalCheck.recognizedText,targetText)>0,placement);
      generationAttempts=1;
      const generatedPath=resolve(directory,'generated-text-1.png');
      imageModelRequested=true;
      const generated=await client.runImageEdit({prompt:basePrompt,inputPaths:[inputPath],
        outputPath:generatedPath,signal:controller.signal});
      model=generated.model??model;
      result=await sharp(await readFile(generatedPath),{limitInputPixels:16_000_000})
        .resize(EDIT_WIDTH,EDIT_HEIGHT,{fit:'fill'}).png().toBuffer();
      failedPreviewBytes=result;
      mask=null;
      outsideMask={mode:'MODEL_FULL_FRAME_NO_MASK',requested:false,programmaticPixelMerge:false};
      await writeFile(outputPath,result);
      const alignment=await verify({context:validationContext,imagePath:outputPath,pageIndex:Number(e.target_page),attempt:1,
        requiredText:required,overlay:placement});
      textCheck=visionTextCheck(alignment,targetText,placement);
    } else if(e.operation==='COMPOSITE') {
      result=await exactComposite(source,refs,config);
      entityConsistency={mode:'DETERMINISTIC_PIXEL_COMPOSITE',passed:true,referenceHashes:refs.map(r=>r.asset.sha256)};
    } else if(e.operation.startsWith('AI_')) {
      if(mock) throw new Error('mock 不生成可采用的 AI 编辑结果');
      const paths=[inputPath];
      for(const [i,ref]of refs.entries()){const path=resolve(directory,`reference-${i}.png`);await writeFile(path,ref.bytes);paths.push(path);}
      if(e.operation==='AI_FUSION') {
        targetLocalization=await validateFusionTarget(client,{inputPath,referencePaths:paths.slice(1),target:config.target,
          referenceMode:config.referenceMode??'STRICT',signal:controller.signal});
        mask=await renderMask({type:'rect',...config.target.region});
        const path=resolve(directory,'target-mask.png');await writeFile(path,mask);paths.push(path);
      } else if(e.operation==='AI_LOCAL') {
        if(config.mask)targetLocalization={mode:'MASK',instruction:config.instruction,region:config.mask};
        else targetLocalization=repairedLocalPlan(config)??acceptedLocalPlan(config)
          ??await validateLocalTarget(client,{inputPath,instruction:config.instruction,signal:controller.signal});
        removedInheritedDisclosure=Boolean(sourceDisclosure
          &&requestsDisclosureRemoval(config.instruction,sourceDisclosure)
          &&localizedTargetIsDisclosure(targetLocalization,sourceDisclosure));
        if(removedInheritedDisclosure) {
          required=required.filter(text=>cleanText(text)!==cleanText(sourceDisclosure));
          disclosure='';
          targetLocalization={...targetLocalization,removedInheritedDisclosure:true};
        }
        directLocalMove=!config.mask&&targetLocalization.operationType==='MOVE'
          &&Boolean(targetLocalization.sourceRegion&&targetLocalization.destinationRegion);
        const activeRegions=config.localRepair?.repairRegions??targetLocalization.editRegions??[targetLocalization.region];
        if(directLocalMove) {
          mask=null;
          if(config.localRepair&&originalInputPath)paths.push(originalInputPath);
          else {
            const protectedSourcePath=resolve(directory,'original-source-reference.png');
            await writeFile(protectedSourcePath,source);paths.push(protectedSourcePath);
          }
          if(needsSoySpoonMoveGuide(targetLocalization)) {
            const directGuidePath=resolve(directory,'direct-move-guide.png');
            await writeFile(directGuidePath,await renderSoySpoonMoveGuide(targetLocalization));paths.push(directGuidePath);
            directMoveGuideAttached=true;
          }
        } else {
          mask=config.mask?await renderMask(config.mask):await renderRegionsMask(activeRegions);
          if(config.localRepair&&originalInputPath)paths.push(originalInputPath);
          if(!config.mask&&targetLocalization.editRegions?.length) {
            const roleGuidePath=resolve(directory,'local-role-guide.png');
            await writeFile(roleGuidePath,await renderLocalRoleGuide(targetLocalization,activeRegions));
            paths.push(roleGuidePath);
          }
          const path=resolve(directory,'mask.png');await writeFile(path,mask);paths.push(path);
        }
      }
      const promptConfig={...config,operation:e.operation,targetPage:Number(e.target_page),
        ...(e.operation==='AI_FUSION'?{referenceProductDescription:targetLocalization.referenceProductDescription}:{}),
        ...(e.operation==='AI_LOCAL'&&!config.mask?(directLocalMove
          ?{localPlan:targetLocalization,localMoveDirect:true,roleGuideAttached:false,directMoveGuideAttached}
          :{localizedRegions:config.localRepair?.repairRegions??targetLocalization.editRegions??[targetLocalization.region],
            localPlan:targetLocalization,roleGuideAttached:Boolean(targetLocalization.editRegions?.length)}):{}),
        ...(removedInheritedDisclosure?{removeDisclosure:sourceDisclosure}:{})};
      imageModelRequested=true;
      {
        if(directLocalMove)localExecutionInstruction=localMoveDirectInstruction(targetLocalization);
        const prompt=aiEditPrompt(context,directLocalMove
          ?{...promptConfig,instruction:localExecutionInstruction}
          :promptConfig,required);
        const generated=await client.runImageEdit({prompt,inputPaths:paths,outputPath:resolve(directory,'generated.png'),signal:controller.signal});
        model=generated.model??null;
        generationAttempts=1;
        // Only consume the requested destination, never a model-supplied filesystem path.
        result=await sharp(await readFile(resolve(directory,'generated.png')),{limitInputPixels:16_000_000}).resize(1086,1448,{fit:'fill'}).png().toBuffer();
        if(directLocalMove)outsideMask={mode:'MODEL_FULL_FRAME_MOVE_WITH_VISION_GATE',requested:false,programmaticPixelMerge:false};
        else if(mask){
          if(e.operation==='AI_LOCAL'&&!config.mask)mask=await changedPixelMask(source,result,mask);
          result=await mergeWithMask(source,result,mask);outsideMask=await assertOutsideMask(source,result,mask);
        }
      }
      failedPreviewBytes=result;
      await writeFile(outputPath,result);
      if(e.operation==='AI_LOCAL'&&!config.mask) {
        try {
          localConsistency=await validateLocalEditResult(client,{inputPath,originalInputPath,outputPath,instruction:localExecutionInstruction,
            plan:targetLocalization,repair:config.localRepair??null,signal:controller.signal});
          const repairAttempt=Number(config.localRepair?.attempt??0);
          const repairMaxAttempts=Number(config.imageEditRepairMaxAttempts??0);
          localConsistency={...localConsistency,repairAttempt,repairMaxAttempts,
            repairableFromRejected:localConsistency.repairableFromRejected&&repairAttempt<repairMaxAttempts};
        } catch(error) {
          error.validation={...(error.validation??{}),model,localization:targetLocalization,localConsistency,outsideMask};
          throw error;
        }
        if(!localConsistency.passed)throw Object.assign(new Error(`局部修改结果未通过验收：${localConsistency.reason||'模型未提供原因'}`),{
          validation:{stage:'LOCAL_EDIT_RESULT',passed:false,billedImageGeneration:true,model,
            localization:targetLocalization,localConsistency,outsideMask},
        });
      }
      if(refs.length){
        const appearanceReference=config.referenceMode==='APPEARANCE';
        const criteria=JSON.stringify({operatorInstruction:config.instruction,target:config.target,
          referenceMode:config.referenceMode??'STRICT',referenceProductDescription:targetLocalization?.referenceProductDescription??null,
          referencePurpose:config.references.map(r=>r.purpose)})
          .replaceAll('<','\\u003c').replaceAll('>','\\u003e');
        const check=await client.runVision({prompt:internalPrompt('INTERNAL_EDIT_PRODUCT_REVIEW', { slot1: (appearanceReference?internalPrompt('INTERNAL_EDIT_APPEARANCE_REVIEW'):internalPrompt('INTERNAL_EDIT_STRICT_REVIEW')), slot2: (criteria) }),inputPaths:[...paths.slice(1,1+refs.length),inputPath,outputPath],signal:controller.signal});
        const parsed=JSON.parse(check.rawText);
        const requiredChecks=['referenceIdentity','targetLocation','singleReplacement','partTopology','unrelatedContentPreserved'];
        const checks=parsed?.checks&&typeof parsed.checks==='object'&&!Array.isArray(parsed.checks)?parsed.checks:{};
        const passed=parsed.passed===true&&requiredChecks.every(name=>checks[name]===true);
        entityConsistency={mode:'AI_REFERENCE_CHECK',passed,checks:Object.fromEntries(requiredChecks.map(name=>[name,checks[name]===true])),reason:String(parsed.reason??'').slice(0,1000),model:check.model??null};
        if(!entityConsistency.passed)throw Object.assign(new Error(`参考实体一致性检查未通过：${entityConsistency.reason||'模型未提供原因'}`),{
          validation:{stage:'ENTITY_CONSISTENCY',passed:false,billedImageGeneration:true,model,
            localization:targetLocalization,entityConsistency,outsideMask},
        });
      }
    }
    await writeFile(outputPath,result);
    const text=textCheck??visionTextCheck(await verify({context:validationContext,imagePath:outputPath,pageIndex:Number(e.target_page),attempt:1,requiredText:required,overlay:null}));
    const finalMetadata=await sharp(result).metadata();
    const restoredPages=[];
    if(context.restored) for(const [index,image]of context.restored.result.images.entries()) {
      if(index===e.target_page-1)continue;
      const asset=await service.asset(image.deliveryAssetId??image.assetId,Number(e.task_id));
      const bytes=await service.readAsset(asset),meta=await sharp(bytes).metadata();
      const path=resolve(directory,`restore-check-${index}.png`);await writeFile(path,bytes);
      const restoredDisclosure=imagePageDisclosure(context.restored.result,index+1)?.text;
      const texts=[...pageText({...context,run:context.restored},index+1),...(restoredDisclosure?[restoredDisclosure]:[])];
      const check=visionTextCheck(await verify({context:{...context,run:context.restored},imagePath:path,pageIndex:index+1,attempt:1,requiredText:texts,overlay:null}));
      if(!check.passed||meta.width!==1086||meta.height!==1448||meta.format!=='png')throw new Error('历史图集存在不合格页面，不能恢复');
      restoredPages.push({page:index+1,assetId:Number(asset.id),sha256:asset.sha256,text:check});
    }
    const promptSnapshot=config.imageEditPrompt??context.imageEditPrompt;
    const addedDisclosure=removedInheritedDisclosure?null
      :config.overlay?.disclosureType?{type:config.overlay.disclosureType,text:config.overlay.text}:inheritedDisclosure??null;
    const validation={passed:text.passed,mock,restoredPages,promptProvenance:promptProvenance(),dimensions:{passed:finalMetadata.width===1086&&finalMetadata.height===1448,width:finalMetadata.width,height:finalMetadata.height},format:finalMetadata.format,
      text,requiredText:required,disclosure:{required:disclosure,added:addedDisclosure,
        ...(removedInheritedDisclosure?{removed:inheritedDisclosure}: {})},integrity:{sha256:imageHash(result)},outsideMask,
      localization:['AI_FUSION','AI_LOCAL'].includes(e.operation)?targetLocalization:null,
      entityConsistency,localConsistency,model,generationAttempts,
      repairAttempt:e.operation==='AI_LOCAL'?Number(config.localRepair?.attempt??0):0,
      repairMaxAttempts:e.operation==='AI_LOCAL'?Number(config.imageEditRepairMaxAttempts??0):0,
      prompt:promptSnapshot?{kind:'IMAGE_EDIT_SYSTEM',versionId:promptSnapshot.versionId??null,version:promptSnapshot.version??null,sha256:promptSnapshot.sha256??promptSnapshot.contentSha256??null,capturedAt:promptSnapshot.capturedAt??null}:null};
    if(!validation.passed||!validation.dimensions.passed||validation.format!=='png') {
      const prefix=e.operation==='TEXT'
        ?'模型生成标识的文字、唯一性、可读性或尺寸校验失败：'
        :'编辑结果视觉验收、必需文字、白名单或尺寸校验失败：';
      throw Object.assign(new Error(prefix+JSON.stringify({missing:text.missing,extra:text.extra,uncertain:text.uncertain,targetOccurrences:text.targetOccurrences,placement:text.placement})),{validation});
    }
    if(lostLease)throw new Error('执行租约失效');
    return {status:'PREVIEW_READY',...await service.complete(e,{bytes:result,mask,validation,originalResult:context.restored?.result})};
    });
  } catch(error) {
    if(error instanceof ImageAlignmentServiceError && !imageModelRequested) {
      error.nonBillablePreflightFailure=true;
      error.validation={stage:alignmentStage==='RESULT'?'RESULT_SERVICE':'SOURCE_SERVICE',passed:false,retryable:error.retryable,
        code:error.code,serviceCode:error.serviceCode,billedImageGeneration:false};
    }
    await service.fail(e,error,imageModelRequested&&failedPreviewBytes?{bytes:failedPreviewBytes}:undefined);
    return {status:'FAILED',error:String(error.message)};
  }
  finally {clearInterval(heartbeat);signal?.removeEventListener('abort',externalAbort);await rm(directory,{recursive:true,force:true});}
}
