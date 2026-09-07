'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea, Checkbox, Switch, Radio, Slider } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { DatePicker } from '@/components/ui/date-picker';
import { ColorPicker } from '@/components/ui/color-picker';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { UserManager } from '@/app/users/user-manager';
import { LocalPromptWorkbench } from '@/app/prompts/local-prompt-workbench';
import { ModelCallTrace } from '@/app/workbench/model-call-trace';
import { ImageSettingsEditor, defaultImageSettings } from '@/app/components/image-controls';

export default function ControlFixture() {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [color, setColor] = useState('#FFFFFF');
  const [imageSettings, setImageSettings] = useState(defaultImageSettings);
  return <ConfirmDialogProvider><div className="stack" style={{ maxWidth: 1100, margin: '0 auto' }}>
    <header><h1>共享组件交互验证</h1><p>本地固定数据，不访问后台或模型。</p></header>
    <section className="panel stack"><h2>搜索与表单</h2>
      <SearchInput aria-label="搜索选题" placeholder="搜索选题" value={search} onValueChange={setSearch} />
      <ul aria-label="搜索结果">{['桌面收纳', '厨房清洁'].filter(item => item.includes(search)).map(item => <li key={item}>{item}</li>)}</ul>
      <form className="stack" aria-label="组件表单" onSubmit={event => { event.preventDefault(); setSubmitted(JSON.stringify([...new FormData(event.currentTarget)])); }}>
        <div className="field"><label htmlFor="fixture-title">标题</label><Input id="fixture-title" name="title" defaultValue="默认标题" required /></div>
        <div className="field"><label htmlFor="fixture-role">表单角色</label><Select name="role" defaultValue="USER"><SelectTrigger id="fixture-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="USER">普通用户</SelectItem><SelectItem value="REVIEWER">审核员</SelectItem><SelectItem value="DISABLED" disabled>不可选角色</SelectItem></SelectContent></Select></div>
        <SearchInput name="query" aria-label="表单搜索" defaultValue="默认搜索" />
        <div className="inline"><label><Checkbox name="approved" defaultChecked /> 已审核</label><label className="switch-field"><Switch name="enabled" defaultChecked /> 启用功能</label><label><Radio name="mode" value="A" defaultChecked /> 模式 A</label><label><Radio name="mode" value="B" /> 模式 B</label></div>
        <DatePicker name="from" label="开始日期" required defaultValue="2026-09-07" />
        <label htmlFor="fixture-note">备注</label><Textarea id="fixture-note" name="note" defaultValue="保留输入内容" />
        <label htmlFor="fixture-slider">质量</label><Slider id="fixture-slider" name="quality" min="1" max="100" defaultValue="80" />
        <fieldset disabled><legend>禁用控件</legend><Checkbox aria-label="禁用复选框" /><Switch aria-label="禁用开关" /><Input aria-label="禁用输入" /></fieldset>
        <div className="inline"><Button unstyled className="button primary" type="submit">提交表单</Button><Button unstyled className="button" type="reset">重置表单</Button></div>
      </form><output aria-label="提交结果">{submitted}</output>
    </section>
    <section className="panel stack"><h2>详情与显示</h2><Disclosure><DisclosureTrigger>展开编辑详情</DisclosureTrigger><DisclosureContent><label htmlFor="details-note">详情备注</label><Input id="details-note" defaultValue="折叠时保留" /><Disclosure><DisclosureTrigger>嵌套详情</DisclosureTrigger><DisclosureContent>嵌套内容</DisclosureContent></Disclosure></DisclosureContent></Disclosure>
      <Progress value={2} max={5} aria-label="完成进度" /><Progress aria-label="读取进度" />
      <label htmlFor="fixture-color">填充色</label><ColorPicker id="fixture-color" value={color} onValueChange={setColor} /><output aria-label="颜色值">{color}</output>
    </section>
    <section className="panel stack"><h2>图片输出设置</h2><ImageSettingsEditor value={imageSettings} onChange={setImageSettings} /></section>
    <section className="panel stack"><h2>提示词管理</h2><LocalPromptWorkbench templates={[]} /></section>
    <section className="stack"><UserManager currentUsername="admin" initialUsers={[{ id: 1, username: 'tester', displayName: '测试用户', role: 'USER', status: 'ACTIVE', mustChangePassword: false, version: 1 }]} /></section>
    <ModelCallTrace taskId={42} />
  </div></ConfirmDialogProvider>;
}
