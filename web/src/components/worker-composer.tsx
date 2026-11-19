"use client";

import * as React from 'react';
import {ArrowUpIcon} from 'lucide-react';
import {api} from '@/lib/api';
import {shouldSubmitOnKey, useChatSendMode} from '@/lib/chat-send-mode';
import {useWorkspaceState} from '@/hooks/use-workspace-state';
import {Field, FieldDescription, FieldGroup, FieldLabel} from '@/components/ui/field';
import {InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea} from '@/components/ui/input-group';
import {Spinner} from '@/components/ui/spinner';

export function WorkerComposer({taskId, intentId, disabledReason, onSent}: {
  taskId: string; intentId: string; disabledReason?: string; onSent: () => void;
}) {
  const [text,setText]=useWorkspaceState(`task:${taskId}`,`worker-draft:${intentId}`,'');
  const [sending,setSending]=React.useState(false);
  const pending=React.useRef(false);
  const [error,setError]=React.useState('');
  const [receipt,setReceipt]=React.useState('');
  const sendMode=useChatSendMode(),id=React.useId();
  const tooLong=Array.from(text).length>4000;
  async function send() {
    if(disabledReason||pending.current||!text.trim()||tooLong)return;
    pending.current=true;setSending(true);setError('');setReceipt('');
    try {
      const result=await api.steerWorker(taskId,intentId,text);
      setText('');
      setReceipt(result.status==='handled'?'消息已由 PI 扩展处理。':'消息已排队，等待当前回合及工具调用结束后交给 Worker。');
      onSent();
    }catch(e){setError(e instanceof Error?e.message:'发送失败，请重试');}
    finally{pending.current=false;setSending(false);}
  }
  return <form className="shrink-0 border-t p-3" onSubmit={e=>{e.preventDefault();void send();}} aria-label={`直接对话 Worker #${intentId}`}>
    <FieldGroup>
      <Field data-invalid={!!error||tooLong} data-disabled={!!disabledReason}>
        <FieldLabel htmlFor={id}>对话 Worker #{intentId}</FieldLabel>
        <InputGroup>
          <InputGroupTextarea id={id} value={text} rows={2} className="max-h-36" disabled={!!disabledReason||sending}
            aria-describedby={`${id}-help`} aria-invalid={!!error||tooLong}
            placeholder="补充信息或调整当前意图的执行方式…"
            onChange={e=>{setText(e.target.value);setError('');setReceipt('');}}
            onKeyDown={e=>{if(shouldSubmitOnKey(e,sendMode)){e.preventDefault();void send();}}}/>
          <InputGroupAddon align="block-end">
            <InputGroupButton type="submit" className="ml-auto" disabled={!!disabledReason||sending||!text.trim()||tooLong} aria-label="发送给 Worker">
              {sending?<Spinner data-icon="inline-start"/>:<ArrowUpIcon data-icon="inline-start"/>}发送
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription id={`${id}-help`}>{disabledReason||'消息直接交给当前 Worker，在当前回合及工具调用结束后生效。'}</FieldDescription>
        {(error||tooLong)&&<p role="alert" className="text-sm text-destructive">{tooLong?'消息最多 4000 字符。':error}</p>}
        {receipt&&<p role="status" className="text-sm text-muted-foreground">{receipt}</p>}
      </Field>
    </FieldGroup>
  </form>;
}
