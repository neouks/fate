"use client";
import { createContext, type ReactNode, useState } from "react";

import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";

export const ComposerBusyContext = createContext<((busy: boolean) => void) | null>(null);

/** Shared input surface for task roles; each role retains its delivery semantics. */
export function ConversationComposer({
  editor,
  actions,
  attachments,
  footer,
  notice,
  leading,
}: {
  editor: ReactNode;
  actions?: ReactNode;
  attachments?: ReactNode;
  footer?: ReactNode;
  notice?: ReactNode;
  leading?: ReactNode;
}) {
  const [compacting, setCompacting] = useState(false);
  return (
    <ComposerBusyContext value={setCompacting}>
      <div className="conversation-composer task-composer" data-compacting={compacting}>
        {attachments}
        <InputGroup className="has-disabled:opacity-100" inert={compacting}>
          {editor}
          {actions && <InputGroupAddon align="inline-end">{actions}</InputGroupAddon>}
        </InputGroup>
        {footer && (
          <div className="conversation-composer-footer">
            {leading}
            {footer}
          </div>
        )}
        {notice && <div className="conversation-composer-notice">{notice}</div>}
      </div>
    </ComposerBusyContext>
  );
}

/** Common conversation frame for main agent, planner and worker transcripts. */
export function ConversationPane({
  label,
  header,
  children,
}: {
  label: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="task-agent-conversation flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <header className="conversation-pane-header">{header}</header>
      {children}
    </section>
  );
}
