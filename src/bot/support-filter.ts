/**
 * Support-mode response pipeline: a prompt instruction block that teaches the
 * agent to answer in plain language for support staff, plus a regex-based
 * output filter that catches any technical details the model might leak.
 *
 * The agent retains FULL tool access during analysis (it still reads code,
 * queries graphs, greps at versions) — the restriction applies only to what
 * appears in the final response.
 */
import type { AgentEvent } from '../agent/types';

export const SUPPORT_MODE_PROMPT = [
  '',
  '## 受众模式：支持人员（强制）',
  '',
  '你的回复面向售前/售后人员，严格遵守以下输出规则：',
  '',
  '【禁止出现】',
  '- 代码片段（任何代码块或行内代码）',
  '- 文件路径和文件名（如 board_system.c、D:\\git\\...）',
  '- 行号（如 :142、L142）',
  '- 函数名/变量名/宏名（如 system_reset()、TEMP_THRESHOLD）',
  '- 协议细节（如 0x8000、Modbus FC=04、LoRaWAN port 85）',
  '- 内部实现逻辑描述',
  '',
  '【必须做到】',
  '- 用通俗语言给结论和操作步骤',
  '- 回答风格参考产品用户手册/FAQ',
  '- 如果问题需要代码知识，你仍然去查代码（用全部工具），但输出时翻译成自然语言',
  '',
  '【示例】',
  '用户问：设备怎么重启？',
  '✅ "长按设备侧面按键 5 秒，指示灯闪烁后松开即可重启。如无响应，长按 10 秒强制重启。"',
  '❌ "在 board_system.c:142 的 system_reset() 中设置了 5s 看门狗..."',
  '',
  '用户问：温湿度不上报了怎么办？',
  '✅ "1. 检查传感器接线是否松动  2. 重启设备  3. 如仍异常请更换传感器或联系研发"',
  '❌ "tsl_extern_sensor() 在 parse_recv_frame() 之后被调用..."',
  '',
  '用户直接要代码：',
  '回复："技术实现细节请咨询研发团队，我这边提供产品使用层面的支持。"',
  '',
].join('\n');

/** Output filter rules — each pattern maps to a replacement string. */
const FILTER_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // Code blocks (```...```) — replace entire block
  { pattern: /```[\s\S]*?```/g, replacement: '[技术细节已隐藏]' },
  // Windows paths
  { pattern: /[A-Z]:\\[^\s"'`）。，]+/g, replacement: '[内部路径]' },
  // File names with extensions (xxx.c, xxx.h, xxx.py, etc.) followed by optional :line
  { pattern: /\b[a-zA-Z_][\w-]*\.(?:c|h|cpp|py|ts|js|json|md|s|ld|S):?\d*/g, replacement: '[内部实现]' },
  // Function names in backticks (like `system_reset`)
  { pattern: /`([a-zA-Z_]\w{2,})\(\)`/g, replacement: '相关功能' },
  // Hex register/address patterns
  { pattern: /\b0x[0-9A-Fa-f]{3,8}\b/g, replacement: '[寄存器配置]' },
  // Line number references like :142, L142
  { pattern: /(?<=\w)[:L]\d{2,4}\b/g, replacement: '' },
];

/**
 * Filter technical details from a response text. Returns the filtered text
 * and the number of substitutions made (for logging/audit).
 */
export function filterSupportOutput(text: string): { filtered: string; hits: number } {
  let hits = 0;
  let filtered = text;
  for (const rule of FILTER_RULES) {
    filtered = filtered.replace(rule.pattern, () => {
      hits++;
      return rule.replacement;
    });
  }
  return { filtered, hits };
}

/**
 * Intercept agent events and filter text deltas for support-mode users.
 * Wraps the event stream so that text/final_text content passes through
 * the filter before reaching the card renderer.
 */
export function wrapEventsForSupportMode(
  events: AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const evt of events) {
        if (evt.type === 'final_text') {
          const { filtered } = filterSupportOutput(evt.content);
          yield { ...evt, content: filtered };
        } else {
          yield evt;
        }
      }
    },
  };
}
