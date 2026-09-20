// Runtime defaults and call sites for supplemental rules and program protocols.
export const INTERNAL_PROMPT_CATALOG = Object.freeze([
  {
    "kind": "INTERNAL_AUTO_PAGE_COUNT",
    "label": "自动页数选择",
    "group": "生成与规划",
    "description": "未指定页数时，根据正文的信息量选择页数。",
    "usage": "未指定页数时，根据正文的信息量选择页数。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/auto_page_count.md",
    "callSites": [
      "src/post-contract.mjs#buildPostPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_FIXED_PAGE_COUNT",
    "label": "指定页数协议",
    "group": "输出与校验协议",
    "description": "用户指定页数时，说明 imagePlan 的固定项数。",
    "usage": "用户指定页数时，说明 imagePlan 的固定项数。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/fixed_page_count.md",
    "callSites": [
      "src/post-contract.mjs#buildPostPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "imageCount"
      },
      {
        "name": "slot2",
        "description": "imageCount"
      }
    ]
  },
  {
    "kind": "INTERNAL_LEGACY_EDITORIAL_WRAPPER",
    "label": "历史文案规则组合",
    "group": "输出与校验协议",
    "description": "兼容未启用完整运行配置的任务，组合管理员文案规则、配图规则和任务数据。",
    "usage": "兼容未启用完整运行配置的任务，组合管理员文案规则、配图规则和任务数据。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/legacy_editorial_wrapper.md",
    "callSites": [
      "src/post-contract.mjs#buildPostPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "editorialInstruction"
      },
      {
        "name": "slot2",
        "description": "imagePlanningRules"
      },
      {
        "name": "slot3",
        "description": "knowledgePrompt"
      },
      {
        "name": "slot4",
        "description": "renderedBasePrompt"
      }
    ]
  },
  {
    "kind": "INTERNAL_IMAGE_PLAN_OUTPUT",
    "label": "正文配图输出协议",
    "group": "输出与校验协议",
    "description": "基于最终正文重新规划配图时，约束字段、页数和长度。",
    "usage": "基于最终正文重新规划配图时，约束字段、页数和长度。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/image_plan_output.md",
    "callSites": [
      "src/post-contract.mjs#buildDynamicImagePlanPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_IMAGE_DISCLOSURE_OVERLAY",
    "label": "合规标识叠加协议",
    "group": "输出与校验协议",
    "description": "程序后置叠加合规标识时，阻止模型重复绘制。",
    "usage": "程序后置叠加合规标识时，阻止模型重复绘制。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/image_disclosure_overlay.md",
    "callSites": [
      "src/image-prompt.mjs#buildGovernedImageTaskPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "complianceDisclosure"
      }
    ]
  },
  {
    "kind": "INTERNAL_IMAGE_PAGE_OUTPUT",
    "label": "完整页面生成协议",
    "group": "输出与校验协议",
    "description": "生图时锁定文字、页归属、画布尺寸及布局参数。",
    "usage": "生图时锁定文字、页归属、画布尺寸及布局参数。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/image_page_output.md",
    "callSites": [
      "src/image-prompt.mjs#buildGovernedImageTaskPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "disclosureRule"
      },
      {
        "name": "slot2",
        "description": "GENERATION_IMAGE_WIDTH"
      },
      {
        "name": "slot3",
        "description": "GENERATION_IMAGE_HEIGHT"
      },
      {
        "name": "slot4",
        "description": "DELIVERY_IMAGE_WIDTH"
      },
      {
        "name": "slot5",
        "description": "DELIVERY_IMAGE_HEIGHT"
      },
      {
        "name": "slot6",
        "description": "fullPageInstructionForLayout(visualPage.layoutTemplate, visualPage.catalogTemplate)"
      }
    ]
  },
  {
    "kind": "INTERNAL_IMAGE_MANUAL_LAYOUT",
    "label": "人工图片配置解读",
    "group": "构图补充",
    "description": "用户指定版式、图文区域或背景时，解释这些配置如何影响画面。",
    "usage": "用户指定版式、图文区域或背景时，解释这些配置如何影响画面。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/image_manual_layout.md",
    "callSites": [
      "src/image-layout-controls.mjs#imageControlsPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "data"
      },
      {
        "name": "slot2",
        "description": "settings ? settings.background === 'SOLID' ? `完整页面使用不透明背景，空白区域底色为 ${settings.backgroundColor}；深色或白色均允许，保持文字对比清晰。` : '保留实际透明像素，不得绘制棋盘格；文字必须在透明与实底预览下均可辨认。' : ''"
      }
    ]
  },
  {
    "kind": "INTERNAL_IMAGE_SOLID_BACKGROUND",
    "label": "实底背景要求",
    "group": "构图补充",
    "description": "图片背景配置为不透明纯色时，指定底色及文字对比。",
    "usage": "图片背景配置为不透明纯色时，指定底色及文字对比。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/image_solid_background.md",
    "callSites": [
      "src/image-layout-controls.mjs#imageControlsPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "settings.backgroundColor"
      }
    ]
  },
  {
    "kind": "INTERNAL_CATALOG_LAYOUT_OUTPUT",
    "label": "布局库区域协议",
    "group": "输出与校验协议",
    "description": "使用版本化布局模板时，传递模板编码、版本和区域关系。",
    "usage": "使用版本化布局模板时，传递模板编码、版本和区域关系。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/catalog_layout_output.md",
    "callSites": [
      "src/layout-contract.mjs#fullPageInstructionForLayout"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "template"
      },
      {
        "name": "slot2",
        "description": "catalogTemplate.templateVersion"
      }
    ]
  },
  {
    "kind": "INTERNAL_LEGACY_LAYOUT_OUTPUT",
    "label": "默认布局区域协议",
    "group": "输出与校验协议",
    "description": "使用默认布局时，传递主体和文字区域定义。",
    "usage": "使用默认布局时，传递主体和文字区域定义。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/legacy_layout_output.md",
    "callSites": [
      "src/layout-contract.mjs#fullPageInstructionForLayout"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "template"
      },
      {
        "name": "slot2",
        "description": "geometry.subjectRegion"
      },
      {
        "name": "slot3",
        "description": "geometry.textSafeRegion"
      }
    ]
  },
  {
    "kind": "INTERNAL_STAGE_REVIEW_OUTPUT",
    "label": "选题与文案审核协议",
    "group": "输出与校验协议",
    "description": "选题审核和文案审核共用的通过、拒绝和问题结构。",
    "usage": "选题审核和文案审核共用的通过、拒绝和问题结构。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/stage_review_output.md",
    "callSites": [
      "src/content-stage-review.mjs#reviewContract"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_TEXT_REVIEW_METRICS",
    "label": "文案审核计数协议",
    "group": "输出与校验协议",
    "description": "传递实际字数、合法范围和本次冻结的编辑要求。",
    "usage": "传递实际字数、合法范围和本次冻结的编辑要求。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/text_review_metrics.md",
    "callSites": [
      "src/content-stage-review.mjs#buildTextReviewPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "reviewContract()"
      },
      {
        "name": "slot2",
        "description": "editorialInstruction"
      }
    ]
  },
  {
    "kind": "INTERNAL_STAGE_REVIEW_RETRY",
    "label": "审核格式重试",
    "group": "失败重试",
    "description": "选题或文案审核返回无效 JSON 时，要求完整重答。",
    "usage": "选题或文案审核返回无效 JSON 时，要求完整重答。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/stage_review_retry.md",
    "callSites": [
      "src/content-stage-review.mjs#runReview"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "JSON.stringify({ validationError: String(lastError?.message ?? lastError).slice(0, 300) })"
      }
    ]
  },
  {
    "kind": "INTERNAL_BODY_REPAIR_OUTPUT",
    "label": "正文修复输出协议",
    "group": "输出与校验协议",
    "description": "正文长度或完整性校验失败时，只允许返回完整 body。",
    "usage": "正文长度或完整性校验失败时，只允许返回完整 body。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/body_repair_output.md",
    "callSites": [
      "src/copy-generation.mjs#buildPostRepairPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_QUALITY_REVISION_OUTPUT",
    "label": "质检修订输出协议",
    "group": "输出与校验协议",
    "description": "质检修订必须保留原结构及无关的合格字段。",
    "usage": "质检修订必须保留原结构及无关的合格字段。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/quality_revision_output.md",
    "callSites": [
      "src/copy-generation.mjs#buildQualityRevisionPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_QUALITY_SCORE_OUTPUT",
    "label": "质量评分输出协议",
    "group": "输出与校验协议",
    "description": "限定评分对象、十个维度和证据结构。",
    "usage": "限定评分对象、十个维度和证据结构。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/quality_score_output.md",
    "callSites": [
      "src/quality-assessment.mjs#buildDeliveryQualityAssessmentPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_QUALITY_SCORE_RETRY",
    "label": "质量评分格式重试",
    "group": "失败重试",
    "description": "图片终审评分结构不合格时，重查全部图片并补齐字段。",
    "usage": "图片终审评分结构不合格时，重查全部图片并补齐字段。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/quality_score_retry.md",
    "callSites": [
      "src/quality-assessment.mjs#buildQualityAssessmentRepairPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "buildDeliveryQualityAssessmentPrompt({ task, post, imageCount })"
      },
      {
        "name": "slot2",
        "description": "JSON.stringify({ validationError })"
      }
    ]
  },
  {
    "kind": "INTERNAL_IMAGE_ALIGNMENT_OUTPUT",
    "label": "图片验收输出协议",
    "group": "输出与校验协议",
    "description": "限定逐字识别、语义和布局判断、失败类型等返回字段。",
    "usage": "限定逐字识别、语义和布局判断、失败类型等返回字段。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/image_alignment_output.md",
    "callSites": [
      "src/image-alignment.mjs#buildImageAlignmentPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "OCR 温度单位等价协议"
      }
    ]
  },
  {
    "kind": "INTERNAL_OCR_CELSIUS_EQUIVALENCE",
    "label": "温度单位等价协议",
    "group": "输出与校验协议",
    "description": "图片验收中 ℃ 与 °C 的等价处理，与程序比较保持一致。",
    "usage": "图片验收中 ℃ 与 °C 的等价处理，与程序比较保持一致。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/ocr_celsius_equivalence.md",
    "callSites": [
      "src/image-alignment.mjs#buildImageAlignmentPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_IMAGE_ALIGNMENT_RETRY",
    "label": "图片验收格式重试",
    "group": "失败重试",
    "description": "图片验收结果不符合 JSON 结构时纠正输出格式。",
    "usage": "图片验收结果不符合 JSON 结构时纠正输出格式。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/image_alignment_retry.md",
    "callSites": [
      "src/image-alignment.mjs#createImageAlignmentValidator"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "lastContractError?.message ?? '结构无效'"
      }
    ]
  },
  {
    "kind": "INTERNAL_REVIEW_IMAGE_PLAN_OUTPUT",
    "label": "界面配图重规划协议",
    "group": "输出与校验协议",
    "description": "用户在文案界面重新生成配图文案时，固定字段与正文边界。",
    "usage": "用户在文案界面重新生成配图文案时，固定字段与正文边界。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/review_image_plan_output.md",
    "callSites": [
      "src/review-image-plan-generation.mjs#buildReviewImagePlanPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_REVIEW_IMAGE_PLAN_RETRY",
    "label": "配图文案格式重试",
    "group": "失败重试",
    "description": "重新规划配图返回无效结构或超长文字时，携带原错误重试。",
    "usage": "重新规划配图返回无效结构或超长文字时，携带原错误重试。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/review_image_plan_retry.md",
    "callSites": [
      "src/review-image-plan-generation.mjs#buildReviewImagePlanPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "prompt"
      },
      {
        "name": "slot2",
        "description": "JSON.stringify({ validationError })"
      }
    ]
  },
  {
    "kind": "INTERNAL_VISUAL_ELEMENTS_ONLY",
    "label": "非文字画面元素协议",
    "group": "输出与校验协议",
    "description": "视觉规划仅输出画面元素；可见文字由程序按锁定文案重建。",
    "usage": "视觉规划仅输出画面元素；可见文字由程序按锁定文案重建。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/visual_elements_only.md",
    "callSites": [
      "src/visual-plan-generation.mjs#module"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_VISUAL_EVIDENCE_OPTIONS",
    "label": "视觉证据引用协议",
    "group": "输出与校验协议",
    "description": "视觉证据必须从服务端候选中逐字选择。",
    "usage": "视觉证据必须从服务端候选中逐字选择。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/visual_evidence_options.md",
    "callSites": [
      "src/visual-plan-generation.mjs#module"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_VISUAL_PLAN_RETRY",
    "label": "视觉规划局部重试",
    "group": "失败重试",
    "description": "视觉规划部分页面失败时，仅返回失败页面并保留已通过页面。",
    "usage": "视觉规划部分页面失败时，仅返回失败页面并保留已通过页面。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/visual_plan_retry.md",
    "callSites": [
      "src/visual-plan-generation.mjs#generateVisualPlan"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "basePrompt"
      },
      {
        "name": "slot2",
        "description": "data({ repairPageIndices: indices, errors: state.errors, previousOutput: previousRaw })"
      }
    ]
  },
  {
    "kind": "INTERNAL_IMAGE_SEARCH_OUTPUT",
    "label": "模拟图片检索协议",
    "group": "输出与校验协议",
    "description": "限定图片检索候选页数、公开网址和归属信息。",
    "usage": "限定图片检索候选页数、公开网址和归属信息。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/image_search_output.md",
    "callSites": [
      "src/deepseek-responses-client.mjs#createDeepSeekResponsesClient"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_IMAGE_SEARCH_RETRY",
    "label": "模拟图片检索重试",
    "group": "失败重试",
    "description": "兼容图片检索返回空值或错误结构时重新搜索。",
    "usage": "兼容图片检索返回空值或错误结构时重新搜索。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/image_search_retry.md",
    "callSites": [
      "src/deepseek-responses-client.mjs#createDeepSeekResponsesClient"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "imagePlan.length"
      }
    ]
  },
  {
    "kind": "INTERNAL_SEARCH_TOOL_EXECUTION",
    "label": "联网检索工具协议",
    "group": "模型执行协议",
    "description": "DeepSeek 联网搜索请求的工具和输出约束。",
    "usage": "DeepSeek 联网搜索请求的工具和输出约束。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/search_tool_execution.md",
    "callSites": [
      "src/deepseek-web-search.mjs#runDeepSeekWebSearch"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_SEARCH_FINALIZATION",
    "label": "检索收尾执行协议",
    "group": "模型执行协议",
    "description": "搜索结束后，仅用已有证据整理结果，不再调用搜索。",
    "usage": "搜索结束后，仅用已有证据整理结果，不再调用搜索。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/search_finalization.md",
    "callSites": [
      "src/deepseek-web-search.mjs#runDeepSeekWebSearch"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_SEARCH_FINAL_JSON",
    "label": "检索收尾输出协议",
    "group": "模型执行协议",
    "description": "搜索收尾时输出摘要和来源，证据不足时返回空来源。",
    "usage": "搜索收尾时输出摘要和来源，证据不足时返回空来源。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/search_final_json.md",
    "callSites": [
      "src/deepseek-web-search.mjs#runDeepSeekWebSearch"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_CODEX_IMAGE_EXECUTION",
    "label": "Codex 图片执行协议",
    "group": "模型执行协议",
    "description": "图片生成或编辑时，约束原生工具调用、画布和文件输出。",
    "usage": "图片生成或编辑时，约束原生工具调用、画布和文件输出。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/codex_image_execution.md",
    "callSites": [
      "src/codex.mjs#executeOnce"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "operation === 'IMAGE_EDIT'\r\n            ? 'Edit the supplied image. Attached image 1 is the edit target; later images are references.'\r\n            : 'Generate a brand-new PNG from the supplied text prompt. Any attached images are visual references only.'"
      },
      {
        "name": "slot2",
        "description": "GENERATION_IMAGE_SIZE"
      },
      {
        "name": "slot3",
        "description": "DELIVERY_IMAGE_WIDTH"
      },
      {
        "name": "slot4",
        "description": "DELIVERY_IMAGE_HEIGHT"
      }
    ]
  },
  {
    "kind": "INTERNAL_CODEX_EDIT_ATTACHMENT",
    "label": "Codex 编辑附件协议",
    "group": "模型执行协议",
    "description": "图片编辑时区分编辑目标和后续参考图。",
    "usage": "图片编辑时区分编辑目标和后续参考图。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/codex_edit_attachment.md",
    "callSites": [
      "src/codex.mjs#executeOnce"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_CODEX_IMAGE_ATTACHMENT",
    "label": "Codex 生图附件协议",
    "group": "模型执行协议",
    "description": "新图生成时将附件解释为视觉参考。",
    "usage": "新图生成时将附件解释为视觉参考。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/codex_image_attachment.md",
    "callSites": [
      "src/codex.mjs#executeOnce"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_CODEX_SEARCH_EXECUTION",
    "label": "Codex 检索执行协议",
    "group": "模型执行协议",
    "description": "要求真实联网搜索及对应来源，外部内容仅作数据。",
    "usage": "要求真实联网搜索及对应来源，外部内容仅作数据。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/codex_search_execution.md",
    "callSites": [
      "src/codex.mjs#executeOnce"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_CODEX_TEXT_EXECUTION",
    "label": "Codex 文本执行协议",
    "group": "模型执行协议",
    "description": "文案或审核调用的工具禁用、数据隔离及返回封装。",
    "usage": "文案或审核调用的工具禁用、数据隔离及返回封装。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/codex_text_execution.md",
    "callSites": [
      "src/codex.mjs#executeOnce"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "structuredText ? 'Return the requested business JSON object directly, conforming to the provided output schema. Do not wrap it in rawText.' : 'Return a JSON object with rawText containing the complete requested answer verbatim, including any requested inner JSON.'"
      }
    ]
  },
  {
    "kind": "INTERNAL_CODEX_STRUCTURED_OUTPUT",
    "label": "Codex 结构化返回协议",
    "group": "模型执行协议",
    "description": "提供输出 schema 时直接返回业务 JSON。",
    "usage": "提供输出 schema 时直接返回业务 JSON。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/codex_structured_output.md",
    "callSites": [
      "src/codex.mjs#executeOnce"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_CODEX_RAW_TEXT_OUTPUT",
    "label": "Codex 原文封装协议",
    "group": "模型执行协议",
    "description": "未提供业务 schema 时，将完整答案放入 rawText。",
    "usage": "未提供业务 schema 时，将完整答案放入 rawText。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/codex_raw_text_output.md",
    "callSites": [
      "src/codex.mjs#executeOnce"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_VISUAL_LAYOUT_SELECTION",
    "label": "视觉布局选择",
    "group": "构图补充",
    "description": "启用布局库的视觉规划中，从候选模板选择版式并说明原因。",
    "usage": "启用布局库的视觉规划中，从候选模板选择版式并说明原因。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/visual_layout_selection.md",
    "callSites": [
      "src/visual-plan.mjs#buildVisualPlanPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_VISUAL_PLAN_OUTPUT",
    "label": "视觉规划输出协议",
    "group": "输出与校验协议",
    "description": "固定视觉规划页数、锁定文字、证据及画布要求。",
    "usage": "固定视觉规划页数、锁定文字、证据及画布要求。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/visual_plan_output.md",
    "callSites": [
      "src/visual-plan.mjs#buildVisualPlanPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "layoutRules"
      },
      {
        "name": "slot2",
        "description": "imageCount"
      },
      {
        "name": "slot3",
        "description": "complianceDisclosure || '关闭'"
      }
    ]
  },
  {
    "kind": "INTERNAL_KNOWLEDGE_MATCH_OUTPUT",
    "label": "案例匹配评分协议",
    "group": "输出与校验协议",
    "description": "对每个知识候选的原始 ID 返回一条绝对匹配分数。",
    "usage": "对每个知识候选的原始 ID 返回一条绝对匹配分数。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/knowledge_match_output.md",
    "callSites": [
      "src/copy-knowledge-match.mjs#scoringPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_RESEARCH_OUTPUT",
    "label": "资料检索输出协议",
    "group": "输出与校验协议",
    "description": "真实联网检索必须返回摘要及限定数量的可核对来源。",
    "usage": "真实联网检索必须返回摘要及限定数量的可核对来源。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/research_output.md",
    "callSites": [
      "src/research-prompt.mjs#buildResearchPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "limit"
      }
    ]
  },
  {
    "kind": "INTERNAL_LAYOUT_CANDIDATE_OUTPUT",
    "label": "布局候选输出协议",
    "group": "输出与校验协议",
    "description": "布局库生成只返回模板结构；来源及启用状态由程序设置。",
    "usage": "布局库生成只返回模板结构；来源及启用状态由程序设置。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/layout_candidate_output.md",
    "callSites": [
      "src/layout-catalog-generation.mjs#generateLayoutCandidates"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_VISUAL_KNOWLEDGE_OUTPUT",
    "label": "视觉知识分析协议",
    "group": "输出与校验协议",
    "description": "定义视觉知识分析字段、类型、变量和评分范围。",
    "usage": "定义视觉知识分析字段、类型、变量和评分范围。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/visual_knowledge_output.md",
    "callSites": [
      "src/admin/visual-knowledge-service.mjs#module"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_COPY_ANALYSIS",
    "label": "优秀文案知识分析",
    "group": "检索与知识库",
    "description": "按知识库中管理员选定的分析要求提炼标题、摘要、完整分析和分类标签。",
    "usage": "按知识库中管理员选定的分析要求提炼标题、摘要、完整分析和分类标签。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/copy_analysis.md",
    "callSites": [
      "server/src/deepseek-copy-analysis.mjs#analysisPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "JSON.stringify(instruction)"
      },
      {
        "name": "slot2",
        "description": "JSON.stringify(source)"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_DISCLOSURE",
    "label": "人工生成标识编辑",
    "group": "图片编辑",
    "description": "通过图片模型为完整原图添加指定合规标识，保留已有内容。",
    "usage": "通过图片模型为完整原图添加指定合规标识，保留已有内容。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_disclosure.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#textEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_PRODUCT_APPEARANCE",
    "label": "产品可见外观替换",
    "group": "图片编辑",
    "description": "外观参考模式下，仅迁移参考图明确展示的主产品外观。",
    "usage": "外观参考模式下，仅迁移参考图明确展示的主产品外观。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_product_appearance.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_PRODUCT_STRICT",
    "label": "产品完整身份替换",
    "group": "图片编辑",
    "description": "严格参考模式下，将选中目标替换为参考产品的完整身份与结构。",
    "usage": "严格参考模式下，将选中目标替换为参考产品的完整身份与结构。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_product_strict.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_REPAIR_ATTACHMENTS",
    "label": "失败图修复附件说明",
    "group": "图片编辑",
    "description": "定向补救以失败图为编辑目标，以最初源图作核对参考。",
    "usage": "定向补救以失败图为编辑目标，以最初源图作核对参考。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_repair_attachments.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_MOVE_ATTACHMENTS",
    "label": "整图移动附件说明（历史停用）",
    "group": "图片编辑",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_move_attachments.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_MOVE_GUIDE",
    "label": "移动几何引导图说明（历史停用）",
    "group": "图片编辑",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_move_guide.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_ROLE_GUIDE",
    "label": "语义位置图说明（历史停用）",
    "group": "图片编辑",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_role_guide.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_REMOVE_PRESERVE",
    "label": "移除标识内容保护",
    "group": "图片编辑",
    "description": "移除指定标识时，保留其余区域和文字。",
    "usage": "移除指定标识时，保留其余区域和文字。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_remove_preserve.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_REMOVE_NEGATIVE",
    "label": "移除标识修改边界",
    "group": "图片编辑",
    "description": "移除指定标识时，禁止修改其余文字和未点名区域。",
    "usage": "移除指定标识时，禁止修改其余文字和未点名区域。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_remove_negative.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_MOVE_FULL_FRAME",
    "label": "对象移动整图编辑（历史停用）",
    "group": "图片编辑",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_move_full_frame.md",
    "callSites": [],
    "variables": [
      {
        "name": "slot1",
        "description": "attachmentContract"
      },
      {
        "name": "slot2",
        "description": "directGuideContract"
      },
      {
        "name": "slot3",
        "description": "repair?'这是对失败结果的定向补救，优先修复 repairInstruction 指定的未完成项，同时保证完整移动任务最终成立。':''"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_MOVE_REPAIR",
    "label": "对象移动失败补救（历史停用）",
    "group": "图片编辑",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_move_repair.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_LOCAL_MASK",
    "label": "局部蒙版编辑",
    "group": "图片编辑",
    "description": "以蒙版约束局部编辑，并在移动时同时处理原位置和新位置。",
    "usage": "以蒙版约束局部编辑，并在移动时同时处理原位置和新位置。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_local_mask.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "attachmentContract"
      },
      {
        "name": "slot2",
        "description": "guideContract"
      },
      {
        "name": "slot3",
        "description": "config.mask?'历史任务':'根据自然语言编辑规划生成'"
      },
      {
        "name": "slot4",
        "description": "repair?'这是对失败结果的定向补救，只修复 repairInstruction 指定的未完成项，不要重新处理已经正确完成的部分。':''"
      },
      {
        "name": "slot5",
        "description": "removal?'移除任务数据 removeDisclosure 字段指定的人工生成标识，除该标识外不得新增、删除或改写任何文字。':'不得新增、删除或改写已有文字。'"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_MASK_REPAIR",
    "label": "蒙版编辑失败补救",
    "group": "图片编辑",
    "description": "蒙版编辑失败后，只处理未完成部分。",
    "usage": "蒙版编辑失败后，只处理未完成部分。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_mask_repair.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_REMOVE_DISCLOSURE",
    "label": "移除指定生成标识",
    "group": "图片编辑",
    "description": "在允许的选区中移除任务点名的标识，其他文字保持原样。",
    "usage": "在允许的选区中移除任务点名的标识，其他文字保持原样。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_remove_disclosure.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_LOCAL_TEXT",
    "label": "按文字定位局部编辑（历史停用）",
    "group": "图片编辑",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_local_text.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_LEGACY_FULL",
    "label": "历史整图编辑",
    "group": "图片编辑",
    "description": "兼容历史整图修改请求，保留未明确要求修改的内容。",
    "usage": "兼容历史整图修改请求，保留未明确要求修改的内容。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_legacy_full.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_TARGET_CHECK",
    "label": "产品替换目标定位检查",
    "group": "编辑检查",
    "description": "付费编辑前核对选区内目标数量、保护范围及参考图可用性。",
    "usage": "付费编辑前核对选区内目标数量、保护范围及参考图可用性。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_target_check.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#validateFusionTarget"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "criteria"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_SOY_SPOON_GEOMETRY",
    "label": "老抽勺移动构图特例（历史停用）",
    "group": "构图补充",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_soy_spoon_geometry.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_DESTINATION_BAND",
    "label": "移动目标参考区域（历史停用）",
    "group": "构图补充",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_destination_band.md",
    "callSites": [],
    "variables": [
      {
        "name": "slot1",
        "description": "Math.round(destination.x/EDIT_WIDTH*100)"
      },
      {
        "name": "slot2",
        "description": "Math.round((destination.x+destination.width)/EDIT_WIDTH*100)"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_SOY_SPOON_DESTINATION",
    "label": "老抽勺目标位置特例（历史停用）",
    "group": "构图补充",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_soy_spoon_destination.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_SPOON_VISIBILITY",
    "label": "勺子移动可见性（历史停用）",
    "group": "构图补充",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_spoon_visibility.md",
    "callSites": [],
    "variables": [
      {
        "name": "slot1",
        "description": "soySpoonTask?'并严格按上述勺碗中心、勺柄端安全带落位':'或上方'"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_SOY_SPOON_PROTECTION",
    "label": "非目标生抽勺保护特例（历史停用）",
    "group": "构图补充",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_soy_spoon_protection.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_EDGE_CLEARANCE",
    "label": "贴边目标移动留白（历史停用）",
    "group": "构图补充",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_edge_clearance.md",
    "callSites": [],
    "variables": [
      {
        "name": "slot1",
        "description": "touchedRight?'贴住右边缘':''"
      },
      {
        "name": "slot2",
        "description": "touchedRight&&touchedBottom?'且':''"
      },
      {
        "name": "slot3",
        "description": "touchedBottom?'贴住下边缘':''"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_MOVE_INSTRUCTION",
    "label": "对象移动完整指令（历史停用）",
    "group": "图片编辑",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_move_instruction.md",
    "callSites": [],
    "variables": [
      {
        "name": "slot1",
        "description": "plan.targetDescription||'任务明确点名的目标对象'"
      },
      {
        "name": "slot2",
        "description": "soySpoonProtection"
      },
      {
        "name": "slot3",
        "description": "destinationAction"
      },
      {
        "name": "slot4",
        "description": "horizontalGuide"
      },
      {
        "name": "slot5",
        "description": "spoonGuide"
      },
      {
        "name": "slot6",
        "description": "edgeGuide"
      },
      {
        "name": "slot7",
        "description": "quantity?`数量或容量要求：${quantity}。`:''"
      },
      {
        "name": "slot8",
        "description": "estimatedPixelDistance?'原始说明没有要求精确像素，已忽略规划器自行估算的像素距离。':''"
      },
      {
        "name": "slot9",
        "description": "plan.relationship?`必须形成的关系：${plan.relationship}。`:''"
      },
      {
        "name": "slot10",
        "description": "flowRequired?'接触关系优先于规划器估算的纵向坐标：为保证内容物确实进入容器，可在保持文字不变的前提下向上调整对象或改变朝向；只有液流可以延伸到锅内食材，目标主体本身仍必须完整且无遮挡；液流必须在容器内食材或液面形成清楚接触点并立即结束，绝不能越过容器下沿。':''"
      },
      {
        "name": "slot11",
        "description": "plan.sourceAction||'彻底移除原位置对象及其痕迹并自然修复背景'"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_FLOW_CONTACT",
    "label": "液流接触关系（历史停用）",
    "group": "构图补充",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_flow_contact.md",
    "callSites": [],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_LOCAL_PLAN",
    "label": "自然语言局部编辑规划（历史停用）",
    "group": "编辑检查",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_local_plan.md",
    "callSites": [],
    "variables": [
      {
        "name": "slot1",
        "description": "criteria"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_LOCAL_REVIEW",
    "label": "局部编辑结果验收（历史停用）",
    "group": "编辑检查",
    "description": "历史局部编辑规则，当前直接编辑流程不再调用。",
    "usage": "仅保留历史提示词版本的查询兼容；当前局部修改不使用此规则。",
    "executionStatus": "RETIRED",
    "editable": false,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_local_review.md",
    "callSites": [],
    "variables": [
      {
        "name": "slot1",
        "description": "repairMode?'第一个附件是最初源图，第二个附件是上次失败结果，第三个附件是本次定向修复结果；必须按最初源图和完整任务核对最终状态，同时确认没有破坏失败结果中已经正确完成的部分。':'第一个附件是编辑前源图，第二个附件是编辑结果。'"
      },
      {
        "name": "slot2",
        "description": "criteria"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_REVIEW_ATTACHMENTS",
    "label": "定向修复验收附件说明",
    "group": "编辑检查",
    "description": "定向补救验收同时比较最初源图、上次失败图和本次修复图。",
    "usage": "定向补救验收同时比较最初源图、上次失败图和本次修复图。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_review_attachments.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#validateLocalEditResult"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_DISCLOSURE_CHECK",
    "label": "标识位置与样式检查",
    "group": "编辑检查",
    "description": "检查指定标识出现次数、位置、字体和可读性。",
    "usage": "检查指定标识出现次数、位置、字体和可读性。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_disclosure_check.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#visionAlignmentInput"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "overlay.text"
      },
      {
        "name": "slot2",
        "description": "overlay.textType"
      },
      {
        "name": "slot3",
        "description": "overlay.position"
      },
      {
        "name": "slot4",
        "description": "overlay.x"
      },
      {
        "name": "slot5",
        "description": "overlay.y"
      },
      {
        "name": "slot6",
        "description": "overlay.width"
      },
      {
        "name": "slot7",
        "description": "overlay.height"
      },
      {
        "name": "slot8",
        "description": "overlay.size"
      },
      {
        "name": "slot9",
        "description": "overlay.color"
      },
      {
        "name": "slot10",
        "description": "overlay.background"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_PRODUCT_REVIEW",
    "label": "真实产品替换验收",
    "group": "编辑检查",
    "description": "替换后核对产品身份、目标位置、替换数量和无关内容保护。",
    "usage": "替换后核对产品身份、目标位置、替换数量和无关内容保护。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_product_review.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#processImageEdit"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "appearanceReference?'当 referenceMode=APPEARANCE 时，只核对 referenceProductDescription 指定主产品的可见颜色、材质、表壳、屏幕、按钮、标志和关键细节；参考图中被遮挡或裁切的部分可沿用源目标的完整结构、姿态与透视，不得因未展示部分与参考图无法逐像素对应而拒绝。参考图里的手部、手腕、背景和次要产品不得出现在结果中。partTopology 只核对可见部件以及补全后是否连续合理。':'产品身份、颜色、轮廓或材质不得偏离完整参考；把手、接口、按钮、标志等部件不得增减、复制、换边或出现拓扑错误。'"
      },
      {
        "name": "slot2",
        "description": "criteria"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_APPEARANCE_REVIEW",
    "label": "外观参考验收尺度",
    "group": "编辑检查",
    "description": "外观模式只核对主产品可见细节及补全合理性。",
    "usage": "外观模式只核对主产品可见细节及补全合理性。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_appearance_review.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#processImageEdit"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_STRICT_REVIEW",
    "label": "完整参考验收尺度",
    "group": "编辑检查",
    "description": "严格模式核对产品结构、颜色、材质及部件拓扑。",
    "usage": "严格模式核对产品结构、颜色、材质及部件拓扑。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_strict_review.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#processImageEdit"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_IMAGE_NO_DISCLOSURE",
    "label": "关闭合规标识协议",
    "group": "输出与校验协议",
    "description": "关闭合规标识时，禁止模型自行添加标识。",
    "usage": "关闭合规标识时，禁止模型自行添加标识。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/image_no_disclosure.md",
    "callSites": [
      "src/image-prompt.mjs#buildGovernedImageTaskPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_CUSTOM_LAYOUT",
    "label": "自定义布局补充",
    "group": "构图补充",
    "description": "使用人工指定布局时，模型补充尚未指定的细节。",
    "usage": "使用人工指定布局时，模型补充尚未指定的细节。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/custom_layout.md",
    "callSites": [
      "src/layout-contract.mjs#fullPageInstructionForLayout"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_TRANSPARENT_BACKGROUND",
    "label": "透明背景要求",
    "group": "构图补充",
    "description": "用户选择透明背景时，保留透明像素并保证文字可读。",
    "usage": "用户选择透明背景时，保留透明像素并保证文字可读。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/transparent_background.md",
    "callSites": [
      "src/image-layout-controls.mjs#imageControlsPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_COPY_REPAIR_OUTPUT",
    "label": "格式修复输出协议",
    "group": "输出与校验协议",
    "description": "格式修复只返回原结构并修改失败字段及必要联动。",
    "usage": "格式修复只返回原结构并修改失败字段及必要联动。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/copy_repair_output.md",
    "callSites": [
      "src/copy-generation.mjs#buildPostRepairPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_BODY_REPAIR_COMPLETENESS",
    "label": "正文修复信息保留",
    "group": "审核与修复",
    "description": "正文压缩或补全时，保留关键事实和数字并完整收尾。",
    "usage": "正文压缩或补全时，保留关键事实和数字并完整收尾。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/body_repair_completeness.md",
    "callSites": [
      "src/copy-generation.mjs#buildPostRepairPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_IMAGE_REPAIR_BOUNDARY",
    "label": "图片修复文字锁定协议",
    "group": "输出与校验协议",
    "description": "验收失败后的图片修复必须保留锁定文字和页归属。",
    "usage": "验收失败后的图片修复必须保留锁定文字和页归属。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/image_repair_boundary.md",
    "callSites": [
      "src/images.mjs#promptWithRepair"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_QUALITY_REPAIR_METHOD",
    "label": "质量问题修复方法",
    "group": "审核与修复",
    "description": "将质量评分证据转成对应维度的修复要求。",
    "usage": "将质量评分证据转成对应维度的修复要求。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/quality_repair_method.md",
    "callSites": [
      "src/quality-repair.mjs#repairMethod"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "key"
      }
    ]
  },
  {
    "kind": "INTERNAL_QUALITY_REPAIR_BOUNDARY",
    "label": "质量修复页归属协议",
    "group": "输出与校验协议",
    "description": "质量修复只处理本页问题，不更换页面信息职责。",
    "usage": "质量修复只处理本页问题，不更换页面信息职责。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/quality_repair_boundary.md",
    "callSites": [
      "src/quality-repair.mjs#appendQualityRepairPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_COPY_ANALYSIS_RETRY",
    "label": "优秀文案分析格式重试",
    "group": "失败重试",
    "description": "知识分析无法解析时，要求重新返回完整 JSON。",
    "usage": "知识分析无法解析时，要求重新返回完整 JSON。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/copy_analysis_retry.md",
    "callSites": [
      "server/src/deepseek-copy-analysis.mjs#callDeepSeek"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "prompt"
      }
    ]
  },
  {
    "kind": "INTERNAL_KNOWLEDGE_FACT_BOUNDARY",
    "label": "案例事实隔离协议",
    "group": "输出与校验协议",
    "description": "借鉴案例时限制案例仅提供表达方法，不能成为选题事实来源。",
    "usage": "借鉴案例时限制案例仅提供表达方法，不能成为选题事实来源。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/knowledge_fact_boundary.md",
    "callSites": [
      "src/copy-knowledge-match.mjs#buildCopyKnowledgeReferencePrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_MANUAL_COPY_REPLAN",
    "label": "人工文案更新后的视觉重规划",
    "group": "生成与规划",
    "description": "人工修改正文后，旧画面方向只保留页类型，具体内容跟随新规划。",
    "usage": "人工修改正文后，旧画面方向只保留页类型，具体内容跟随新规划。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/manual_copy_replan.md",
    "callSites": [
      "src/pipeline.mjs#processNext"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_POST_OUTPUT",
    "label": "文案完整结构协议",
    "group": "输出与校验协议",
    "description": "文案初稿的完整 JSON 字段、枚举、来源和风险记录要求。",
    "usage": "每次生成完整文案时，与管理员文案规则及配图规则共同组成请求。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/post.md",
    "callSites": [
      "src/post-contract.mjs#buildPostPrompt"
    ],
    "variables": [
      {
        "name": "TASK_JSON",
        "description": "当前任务的选题、输入资料和图片数量"
      },
      {
        "name": "DELIVERY_IMAGE_COUNT_RULE",
        "description": "自动页数范围或用户指定的图片数量"
      }
    ]
  },
  {
    "kind": "INTERNAL_STYLE_AUDIT_TOOL",
    "label": "套图风格离线检查协议",
    "group": "联调辅助",
    "description": "离线脚本检查整套字体、文字框、强调色及版式一致性；不参与正常生产流程。",
    "usage": "只在 scripts/audit-image-set-style.mjs 独立检验工具运行时调用；输出字段和判定尺度与脚本机械检查对应。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/style_audit_tool.md",
    "callSites": [
      "scripts/audit-image-set-style.mjs#styleAuditPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "附件图片数量 imageCount"
      }
    ]
  },
  {
    "kind": "INTERNAL_LOCAL_IMAGE_EDIT_OUTPUT",
    "label": "本地图片编辑输出协议",
    "group": "输出与校验协议",
    "description": "本地离线图片编辑的原图保护、锁定文字验收和单张输出要求。",
    "usage": "本地管理界面的图片修改任务调用；不改变已有交付页的文字验收。",
    "editable": false,
    "layer": "CONTRACT",
    "defaultPath": "prompts/internal/local_image_edit_output.md",
    "callSites": [
      "src/admin/image-edit-worker.mjs#processImageEditRequest"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_DYNAMIC_IMAGE_PLAN_RETRY",
    "label": "最终正文分页格式重试",
    "group": "失败重试",
    "description": "人工修改正文后重新选择图片页数，规划结构失败时携带原错误重试。",
    "usage": "本地完整管线依据最终正文重新分页，首次规划输出不合格时调用。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/dynamic_image_plan_retry.md",
    "callSites": [
      "src/pipeline.mjs#buildDynamicImagePlanRepairPrompt"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "根据最终正文构造的完整配图规划请求"
      },
      {
        "name": "slot2",
        "description": "本次结构校验错误 JSON"
      }
    ]
  },
  {
    "kind": "INTERNAL_EDIT_DIRECT_TEXT",
    "label": "直接局部图片编辑",
    "group": "图片编辑",
    "description": "依据原图与说明直接完成修改，不使用视觉规划选区。",
    "usage": "依据原图与说明直接完成修改，不使用视觉规划选区。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_direct_text.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#aiEditPrompt"
    ],
    "variables": []
  },
  {
    "kind": "INTERNAL_EDIT_DIRECT_REVIEW",
    "label": "直接局部图片结果验收",
    "group": "编辑检查",
    "description": "依据原图、说明与结果验收修改完成度、文字和未点名内容，不依赖规划坐标。",
    "usage": "依据原图、说明与结果验收修改完成度、文字和未点名内容，不依赖规划坐标。",
    "editable": true,
    "layer": "SUPPLEMENT",
    "defaultPath": "prompts/internal/edit_direct_review.md",
    "callSites": [
      "server/src/image-edit-renderer.mjs#validateLocalEditResult"
    ],
    "variables": [
      {
        "name": "slot1",
        "description": "repairMode?'第一个附件是最初源图，第二个附件是上次失败结果，第三个附件是本次定向修复结果；必须按最初源图和完整任务核对最终状态，同时确认没有破坏失败结果中已经正确完成的部分。':'第一个附件是编辑前源图，第二个附件是编辑结果。'"
      },
      {
        "name": "slot2",
        "description": "criteria"
      }
    ]
  }
].map(item=>Object.freeze(item)));
