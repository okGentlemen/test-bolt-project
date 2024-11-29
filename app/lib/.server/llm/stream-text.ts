import { streamText as _streamText, convertToCoreMessages } from 'ai';
import { getAPIKey, getDeepseekAPIKey } from '~/lib/.server/llm/api-key';
import { getAnthropicModel, getDeepseekModel } from '~/lib/.server/llm/model';
import { MAX_TOKENS } from './constants';
import { getSystemPrompt } from './prompts';

interface ToolResult<Name extends string, Args, Result> {
  toolCallId: string;
  toolName: Name;
  args: Args;
  result: Result;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolInvocations?: ToolResult<string, unknown, unknown>[];
}

export type Messages = Message[];

export type StreamingOptions = Omit<Parameters<typeof _streamText>[0], 'model'>;

const defaultInstructions = `
For all designs I ask you to make, have them be beautiful, not cookie cutter. Make webpages that are fully featured and worthy for production.

By default, this template supports JSX syntax with Tailwind CSS classes, React hooks, and Lucide React for icons. Do not install other packages for UI themes, icons, etc unless absolutely necessary or I request them.

Use icons from lucide-react for logos.

Use stock photos from unsplash where appropriate, only valid URLs you know exist. Do not download the images, only link to them in image tags.`;

export function streamText(messages: Messages, env: Env, options?: StreamingOptions) {
  const deepseekApiKey = getDeepseekAPIKey(env)
  const useDeepseek = !!deepseekApiKey
  
  const processedMessages = [...messages];
  if (processedMessages.length > 0) {
    const lastMessage = processedMessages[processedMessages.length - 1];
    if (lastMessage.role === 'user') {
      lastMessage.content = `${lastMessage.content}\n\n${defaultInstructions}`;
    }
  }

  if (useDeepseek) {
    return _streamText({
      model: getDeepseekModel(deepseekApiKey),
      system: getSystemPrompt(),
      messages: convertToCoreMessages(processedMessages),
      maxTokens: MAX_TOKENS,
      ...options,
    });
  }

  return _streamText({
    model: getAnthropicModel(getAPIKey(env)),
    system: getSystemPrompt(),
    maxTokens: MAX_TOKENS,
    headers: {
      'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
    },
    messages: convertToCoreMessages(processedMessages),
    ...options,
  });
}
