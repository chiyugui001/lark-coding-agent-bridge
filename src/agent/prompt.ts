export type BridgePromptSource = 'im' | 'card' | 'comment';

export interface BridgePromptMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BridgePromptContext {
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  /** Whether the sender is a human user or another bot ('app' sender). */
  senderType?: 'user' | 'bot';
  /** The bridge bot's own open_id — "this id is you" for self-identification. */
  botOpenId?: string;
  /** Accounts @-mentioned in the triggering message(s), deduped across the batch. */
  mentions?: BridgePromptMention[];
  threadId?: string;
  messageIds?: string[];
  source: BridgePromptSource;
}

export interface BridgePromptQuotedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptInteractiveCard {
  messageId?: string;
  content: unknown;
}

/**
 * A prior message in the same Feishu topic, supplied as read-only context when
 * the bot is first pulled into a topic it hasn't been part of. Distinct from
 * `quotedMessages` (an explicit reply-quote): this is the topic's upstream
 * conversation the bot would otherwise be blind to.
 */
export interface BridgePromptTopicMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptComment {
  commentScopeId: string;
  isWholeDocument: boolean;
  docsLink?: string;
  question: string;
  quote?: string;
}

export interface BridgePromptAttachment {
  path: string;
  kind: string;
  hash?: string;
  size?: number;
  mime?: string;
  sourceMessageId?: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
}

export interface BuildAgentPromptInput {
  context: BridgePromptContext;
  instructions?: string[];
  userInput: string;
  topicContext?: BridgePromptTopicMessage[];
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  comment?: BridgePromptComment;
  attachments?: BridgePromptAttachment[];
  /**
   * Per-user persistent memory content; rendered as a <user_memory> block
   * right after bridge_context. `memoryFilePath` (write-privileged users
   * only) tells the agent it may edit the file directly.
   */
  userMemory?: {
    content: string;
    memoryFilePath?: string;
    /**
     * True while the user's memory is still empty — the agent should run the
     * first-conversation onboarding (ask role / reply style / preferences,
     * then persist them via the memory_write protocol).
     */
    onboarding?: boolean;
  };
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const sections = [
    promptSection('bridge_context', input.context),
    input.userMemory
      ? promptSection('user_memory', {
          note: '该用户跨会话的持久记忆。仅对此用户可见。',
          ...(input.userMemory.memoryFilePath
            ? {
                note_can_edit:
                  '你可以用文件工具更新这个记忆文件（追加/修改/精简），它会在该用户之后每轮注入。',
                memory_file: input.userMemory.memoryFilePath,
              }
            : {}),
          memory: input.userMemory.content || '（暂无记忆——尚未完成初始化引导）',
          ...(input.userMemory.onboarding && !input.userMemory.content
            ? {
                onboarding_mode:
                  '该用户还没有任何记忆（首次使用）。在本轮及后续几轮对话中执行初始化引导：' +
                  '1) 若用户上来就问正事，先正常回答正事，在回复结尾用一两句话自然引出引导；' +
                  '2) 引导时一次性提出下面这组问题（不要连环单独追问）：' +
                  '① 怎么称呼你，你的角色/职业是什么（希望 AI 从什么视角分析问题）；' +
                  '② 偏好的回复风格（结论位置、详略程度、语言习惯）；' +
                  '③ 主要工作领域/常用技术栈；' +
                  '④ 其他希望 AI 长期记住的偏好（可跳过）。' +
                  '3) 用户回答后（哪怕只答了部分），提炼润色成记忆条目并通过 memory_write 协议写入，并确认已记住；' +
                  '4) 若用户没有配合引导，不要重复追问，正常服务，仅在其后某轮自然结束时再轻提一次（全程最多两次）。' +
                  '引导只依赖对话完成，不需要任何工具调用。',
              }
            : {}),
          memory_write_protocol:
            '当用户要求把信息存入长期记忆时，在回复最末尾输出一个 <memory_write>记忆内容</memory_write> 块。块内是你提炼润色后的记忆条目：结构化、简洁、书面化，去掉口语和冗余——不要照抄用户原话。bridge 会负责写入记忆文件（你不需要也不能自己写该文件），写入后回复正文中简短确认已记住即可。仅在用户明确要求记住/更新记忆时输出该块。',
        })
      : undefined,
    input.instructions && input.instructions.length > 0
      ? promptSection('bridge_instructions', input.instructions)
      : undefined,
    input.topicContext && input.topicContext.length > 0
      ? promptSection('topic_context', input.topicContext)
      : undefined,
    input.quotedMessages && input.quotedMessages.length > 0
      ? promptSection('quoted_messages', input.quotedMessages)
      : undefined,
    input.interactiveCards && input.interactiveCards.length > 0
      ? promptSection('interactive_cards', input.interactiveCards)
      : undefined,
    input.comment ? promptSection('comment_context', input.comment) : undefined,
    promptSection('user_input', {
      text: input.userInput,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    }),
  ];

  return sections.filter(Boolean).join('\n\n');
}

export function promptSection(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJsonStringify(value)}\n</${tag}>`;
}

export function safeJsonStringify(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
