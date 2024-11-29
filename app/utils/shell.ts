import type { WebContainerSim } from '~/lib/webcontainer/WebContainerSim';
import type { ITerminal } from '~/types/terminal';
import { withResolvers } from './promises';
import { chatStore } from '~/lib/stores/chat';

// 改进清理控制字符的函数
function cleanTerminalOutput(output: string): string {
  return output
    // 移除 ANSI 转义序列
    .replace(/\x1B\[[0-9;]*[JKmsu]/g, '')
    // 移除特殊控制字符如 [?2004h 和 [?2004l
    .replace(/\[(\?|\d)[0-9;]*[a-zA-Z]/g, '')
    // 保留换行符，但移除其他控制字符
    .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '')
    // 移除连续的空行
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    // 移除行首行尾空白字符，但保留行间的空格
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // 移除开头和结尾的空行
    .trim();
}

export async function newShellProcess(webcontainer: WebContainerSim, terminal: ITerminal) {
  const process = await webcontainer.initTerminal();

  const input = process.input.getWriter();
  const output = process.output;

  const jshReady = withResolvers<void>();
  let isInteractive = false;

  let outputBuffer = '';
  const errorKeywords = ['error', 'exception', 'failed', 'failure'];

  output.pipeTo(
    new WritableStream({
      write(data) {
        if (!isInteractive && data.length > 0) {
          isInteractive = true;
          jshReady.resolve();
        }
        outputBuffer += data;
        
        const hasError = errorKeywords.some(keyword => 
          outputBuffer.toLowerCase().includes(keyword)
        );
        
        if (hasError) {
          chatStore.setKey('shellError', cleanTerminalOutput(outputBuffer));
        }
        
        terminal.write(data);
      },
    }),
  );

  terminal.onData((data) => {
    if (isInteractive) {
      input.write(data);
    }
  });

  await jshReady.promise;

  const execSh = async (command: string) => {
    outputBuffer = '';
    terminal.write(command + '\n');
    process.exec_sh_server(command); 
  };

  return Object.assign(process, { exec_sh: execSh });
}
