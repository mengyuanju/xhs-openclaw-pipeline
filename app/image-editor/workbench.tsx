'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';
import { apiRequest } from '../components/api-client';
import { createRequestId } from '../components/request-id';
import { StandaloneImageEditor } from '../components/standalone-image-editor';
import { ImageEditorList } from './image-editor-list';
import { STANDALONE_IMAGE_EDITOR_LIMITS as limits } from '../../src/standalone-image-editor-config.mjs';
import styles from './workbench.module.css';

type Workspace = { id:number; title:string; runId:string; copyRevisionId:number; assets:Array<{id:number;url:string;sha256:string}>; runs:Array<{id:string;result:{processing?:{type:string}}|null}> };
const url = (value:string) => `/api/control-plane${value}`;
function encodedFile(file:File):Promise<string> {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}
export function ImageEditorWorkbench() {
  const [open,setOpen] = useState(false), [workspace,setWorkspace] = useState<Workspace|null>(null);
  const [page,setPage] = useState(1), [title,setTitle] = useState('');
  const [busy,setBusy] = useState(false), [editorBusy,setEditorBusy] = useState(false);
  const [error,setError] = useState(''), [notice,setNotice] = useState(''), [refreshKey,setRefreshKey] = useState(0);
  const requestId = useRef(createRequestId()), selection = useRef(0);
  const locked = busy || editorBusy;
  const select = useCallback(async (id:number) => {
    const token = ++selection.current;
    setOpen(true);setWorkspace(null);setPage(1);setError('');setNotice('');setBusy(true);
    try {
      const value = await apiRequest<Workspace>(url(`/v1/image-editor/workspaces/${id}`));
      if (selection.current !== token) return;
      setWorkspace(value);
      window.history.replaceState(null,'',`/image-editor?workspace=${id}`);
    } catch(e) { if(selection.current === token)setError(e instanceof Error ? e.message : '读取图片失败'); }
    finally { if(selection.current === token)setBusy(false); }
  },[]);
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get('workspace'));
    if(Number.isSafeInteger(id) && id > 0)void select(id);
    return () => { selection.current += 1; };
  },[select]);
  function startNew() {
    selection.current += 1;
    setWorkspace(null);setPage(1);setTitle('');setError('');setNotice('');setBusy(false);setEditorBusy(false);
    requestId.current = createRequestId();
    window.history.replaceState(null,'','/image-editor');
  }
  function close() {
    selection.current += 1;
    setOpen(false);setEditorBusy(false);
    window.history.replaceState(null,'','/image-editor');
  }
  async function upload(files:File[]) {
    if(!files.length)return;
    if(files.length > limits.maxImages || files.some(file => !limits.formats.includes(file.type) || file.size > limits.maxUploadBytes)) {
      setError(`每次最多上传 ${limits.maxImages} 张 PNG/JPEG/WebP，每张不超过 ${limits.maxUploadBytes/1024/1024} MB`);return;
    }
    setBusy(true);setError('');
    try {
      const images = await Promise.all(files.map(async file => ({mediaType:file.type,base64:await encodedFile(file)})));
      const value = await apiRequest<Workspace>(url('/v1/image-editor/workspaces'), {
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({requestId:requestId.current,title:title.trim() || files[0].name.slice(0,200),images}),
      });
      setWorkspace(value);setPage(1);
      window.history.replaceState(null,'',`/image-editor?workspace=${value.id}`);
    } catch(e) { setError(e instanceof Error ? e.message : '上传失败'); }
    finally { setBusy(false); }
  }
  async function changed() {
    setRefreshKey(key => key+1);
    if(!workspace)return;
    const token = selection.current;
    const value = await apiRequest<Workspace>(url(`/v1/image-editor/workspaces/${workspace.id}`));
    if(token === selection.current)setWorkspace(value);
  }
  function submitted() {
    close();setRefreshKey(key => key+1);setNotice('已保存并提交生图，可在下方列表查看进度。');
  }
  const asset = workspace?.assets[page-1];
  return <Dialog open={open} onOpenChange={next => {if(locked)return;if(next)setOpen(true);else close();}}>
    <div className={styles.workbench}>
      <header className={styles.pageHeader}><h1>图片编辑</h1><DialogTrigger asChild><Button onClick={startNew}><Plus size={16} aria-hidden="true"/>新增图片</Button></DialogTrigger></header>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <ImageEditorList refreshKey={refreshKey} onSelect={id => void select(id)}/>
    </div>
    <DialogContent className={styles.dialog} overlayClassName={styles.overlay} showCloseButton={!locked} onPointerDownOutside={event => event.preventDefault()}>
      <header className={styles.dialogHeader}><DialogTitle className={styles.dialogTitle}>{workspace ? '编辑图片' : '新增图片'}</DialogTitle>
        <DialogDescription className="subtle">上传图片后设置修改内容，保存即提交生图。</DialogDescription></header>
      <div className={styles.dialogBody}>
        <section className={styles.upload} aria-label="上传图片">
          {workspace ? <div className={styles.uploaded}><div><strong>{workspace.title}</strong><p className="subtle">已上传 {workspace.assets.length} 张图片</p></div>
            <div className={styles.pages}>{workspace.assets.map((item,index) => <Button key={item.id} size="sm" variant={page === index+1 ? 'default' : 'outline'} disabled={locked} aria-pressed={page === index+1} onClick={() => setPage(index+1)}>第 {index+1} 张</Button>)}</div>
            {asset && <a className={styles.download} href={url(`${asset.url}?download=true`)} download>下载当前图片</a>}
          </div> : <>
            <label className={styles.titleInput}>图片名称（可选）<Input maxLength={200} value={title} disabled={busy} onChange={event => {setTitle(event.target.value);requestId.current=createRequestId();}} placeholder="例如：产品图片调整"/></label>
            <label className={styles.filePicker}><UploadCloud size={26} aria-hidden="true"/><strong>{busy ? '正在读取图片…' : '选择要编辑的图片'}</strong><span className="subtle">{limits.width} × {limits.height} · PNG / JPEG / WebP · 每张最多 {limits.maxUploadBytes/1024/1024} MB · 最多 {limits.maxImages} 张</span>
              <Input aria-label="上传待编辑图片" type="file" multiple accept={limits.formats.join(',')} disabled={busy} onChange={event => {const files=Array.from(event.target.files ?? []);event.target.value='';requestId.current=createRequestId();void upload(files);}}/>
            </label>
          </>}
          {error && <p className="notice" role="alert">{error}</p>}
        </section>
        {workspace && asset && <StandaloneImageEditor key={`${workspace.id}:${page}`} taskId={workspace.id} runId={workspace.runId} copyRevisionId={workspace.copyRevisionId} asset={asset} assets={workspace.assets} page={page} runs={workspace.runs} onChanged={changed} onSubmitted={submitted} onBusyChange={setEditorBusy}/>}
      </div>
    </DialogContent>
  </Dialog>;
}
