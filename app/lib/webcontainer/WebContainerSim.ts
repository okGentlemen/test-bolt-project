import { WORK_DIR } from "~/utils/constants";

// Add interface for domains response
interface DomainsResponse {
  success: boolean;
  message: string;
  data: {
    domains: string[];
    token: string;
  }
}

export interface Process {
  input: WritableStream<string>;
  output: ReadableStream<string>;
  kill: () => void;
  resize: (cols: number, rows: number) => void;
  interrupt: () => void;
}

interface FileSystemEntry {
  type: 'file' | 'directory';
  content?: string;
  children?: Map<string, FileSystemEntry>;
  isBase64?: boolean;
}


interface PendingSync {
  path: string;
  content: string;
  operation: 'write' | 'mkdir';
  retryCount: number;
  isBase64?: boolean;
}

// Add new interface for terminal management
interface Terminal extends Process {
  id: string;
  createdAt: number;
  exec_sh_server?: (command: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  ws: WebSocket;
  interrupt: () => void;
}

const SSH_SERVER = '192.168.11.10:31775';
const WS_SERVER = `ws://${SSH_SERVER}/ws`;
// const API_SERVER = 'http://192.168.11.10:30535'; // Add this line

const API_SERVER = 'http://121.41.165.96'; // Add this line

// 添加新的类型定义
interface OSSUploadResponse {
  success: boolean;
  message: string;
  url: string;
}

interface OSSTreeResponse {
  success: boolean;
  message: string;
  tree: string[]; // Changed from nested object to string array
}

// Add interface for the response data type
interface APIResponse {
  success: boolean;
  message: string;
}

// Add this function at the top level before the class definition
function setCookie(name: string, value: string, domain: string) {
  const cookieValue = encodeURIComponent(value);
  const baseDomain = domain.split('.').slice(1).join('.');
  document.cookie = `${name}=${cookieValue}; path=/; domain=.${baseDomain}`;
}

export class WebContainerSim {
  private fileSystem: Map<string, FileSystemEntry>;
  private sshSession: Terminal | null = null;
  private pendingSyncs: PendingSync[] = [];
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  public workdir: string = WORK_DIR;
  private containerPath: string;
  private terminals: Map<string, Terminal> = new Map();
  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder();
  private apiPrefix: string; // Add this line
  private wsServer: string;
  public previewServers: string[] = [];
  public authToken: string = '';
  // 更新命令枚举
  private readonly Command = {
    // server side
    OUTPUT: '0',
    SET_WINDOW_TITLE: '1',
    SET_PREFERENCES: '2',

    // client side
    INPUT: '0',
    RESIZE_TERMINAL: '1',
    PAUSE: '2',
    RESUME: '3'
  };

  constructor(uid: string, projectName: string = '') {
    this.fileSystem = new Map();
    this.containerPath = `/data/raid0/ccc/testproj/${projectName}`;
    this.apiPrefix = `${uid}/${projectName}`; // Add this line
    this.wsServer = WS_SERVER;
    
    // 处理热更新
    if (import.meta.hot) {
      // 保存当前状态
      import.meta.hot.data.fileSystem = this.fileSystem;
      import.meta.hot.data.pendingSyncs = this.pendingSyncs;
      
      // 清理函数
      import.meta.hot.dispose(() => {
        this.cleanup();
      });
    }
    
    this.startSyncInterval();
    // this.initializeDomains();
  }

  async initializeDomains() {
    try {
      const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/domains`, {
        credentials: 'include'
      });
      
      const data = await response.json() as DomainsResponse;
      if (!data.success || !data.data.domains.length) {
        throw new Error(data.message || 'No domains available');
      }

      // First domain is for terminal
      const terminalDomain = data.data.domains[0];
      this.wsServer = `ws://${terminalDomain}/ws`;
      this.previewServers = data.data.domains.slice(1);
      
      // 初始化 WebSocket 时使用 token
      const authToken = data.data.token;
      this.authToken = authToken;

      // Extract the base domain from API_SERVER
      const apiUrl = new URL(window.location.origin);
      const baseDomain = apiUrl.hostname;

      // Set the Authorization cookie for the entire domain
      setCookie('Authorization', authToken, baseDomain);

      // console.log('====cookie==========',document.cookie, baseDomain);
      
      // console.log('[WebContainerSim] authToken= set cookie=====', authToken); 

    } catch (error) {
      console.error('Failed to initialize domains:', error);
      throw error;
    }
  }

  private startSyncInterval() {
    // 如果已经有同步间隔在运行，先清理
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.syncInterval = setInterval(() => this.processPendingSyncs(), 5000);
  }

  private async processPendingSyncs() {
    const MAX_RETRIES = 3;
    
    for (let i = 0; i < this.pendingSyncs.length; i++) {
      const sync = this.pendingSyncs[i];
      try {
        if (sync.operation === 'write') {
          await this.syncFileToContainer(sync.path, sync.content);
        } else if (sync.operation === 'mkdir') {
          await this.syncDirToContainer(sync.path);
        }
        // Remove successful sync
        this.pendingSyncs.splice(i, 1);
        i--;
      } catch (error) {
        console.error(`Failed to sync ${sync.path}:`, error);
        sync.retryCount++;
        if (sync.retryCount >= MAX_RETRIES) {
          console.error(`Max retries reached for ${sync.path}, removing from queue`);
          this.pendingSyncs.splice(i, 1);
          i--;
        }
      }
    }
  }

  private toContainerPath(userPath: string): string {
    const relativePath = userPath.startsWith(this.workdir) 
      ? userPath.slice(this.workdir.length) 
      : userPath;
    return `${this.containerPath}${relativePath}`;
  }

  async spawn_sync(command: string, args: string[] = []): Promise<{
    exit: number;
    output: string;
  }> {
    const tempTerminal = await this.initTerminal();
    const marker = `__CMD_COMPLETE_${Math.random().toString(36).substring(7)}__`;
    const fullCommand = `${command} ${args.join(' ')}; echo "${marker}"`;
    
    try {
      // Collect output
      let output = '';
      const reader = tempTerminal.output.getReader();
      
      // Send command
      const writer = tempTerminal.input.getWriter();
      await writer.write(fullCommand + '\n');
      writer.releaseLock();

      // Wait for command completion and collect output
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        output += value;
        
        // Check if command has completed using our marker
        if (output.includes(marker)) {
          break;
        }
      }

      // Clean up
      reader.releaseLock();
      tempTerminal.kill();

      // Remove the command echo and completion marker from output
      output = output.replace(fullCommand, '').trim();
      output = output.replace(marker, '').trim();

      return {
        exit: 0,
        output
      };
    } catch (error: unknown) {
      tempTerminal.kill();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        exit: 1,
        output: errorMessage
      };
    }
  }

  private async syncFileToContainer(path: string, content: string) {
    try {
      const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/oss/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key: path,
          content: content
        }),
        credentials: 'include'
      });
      
      const data = await response.json() as APIResponse;
      if (!data.success) {
        throw new Error(data.message);
      }
      console.log('==========syncFileToContainer========', path, 'finish');
    } catch (error) {
      console.error('Error syncing file to container:', error);
      throw error;
    }
  }

  private async syncDirToContainer(path: string) {
    try {
      // 创建目录通过创建一个空的 .gitkeep 文件来实现
      const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/oss/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key: `${path}/.gitkeep`,
          content: ''
        }),
        credentials: 'include'
      });
      
      const data = await response.json() as OSSUploadResponse;
      if (!data.success) {
        throw new Error(data.message);
      }
    } catch (error) {
      console.error('Error creating directory in container:', error);
      throw error;
    }
  }

  public fs = {
    writeFile: async (path: string, content: string | Uint8Array): Promise<void> => {
      const fullPath = `${this.workdir}/${path}`;
      
      // Convert content to string
      const contentStr = content instanceof Uint8Array ? 
        Buffer.from(content).toString('base64') :
        content;
      
      const isBase64 = content instanceof Uint8Array;

      // 立即更新本地缓存
      this.updateFileSystem(fullPath, {
        type: 'file',
        content: contentStr,
        isBase64: isBase64
      });

      // 异步同步到服务端
      try {
        const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/oss/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            key: path,
            content: contentStr,
            isBase64: isBase64
          }),
          credentials: 'include'
        });
        
        const data = await response.json() as OSSUploadResponse;
        if (!data.success) {
          throw new Error(data.message);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error('Error syncing file to server:', error);
        // 可以考虑添加到重试队列
        this.pendingSyncs.push({
          path: path,
          content: contentStr,
          operation: 'write',
          retryCount: 0,
          isBase64: isBase64
        });
      }
    },

    readFile: async (path: string): Promise<Uint8Array> => {
      const fullPath = `${this.workdir}/${path}`;
      
      // 首先检查本地缓存
      const cachedEntry = this.getFileFromPath(fullPath);
      if (cachedEntry && cachedEntry.type === 'file' && cachedEntry.content !== undefined) {
        if (cachedEntry.isBase64) {
          return Buffer.from(cachedEntry.content, 'base64');
        }
        return this.textEncoder.encode(cachedEntry.content);
      }

      // 如果缓存中没有，从服务器获取
      try {
        const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/oss/download/${path}`, {
          credentials: 'include'
        });
        
        if (!response.ok) {
          throw new Error(`Failed to read file: ${response.statusText}`);
        }
        
        const content = await response.text();
        
        // 更新缓存
        this.updateFileSystem(fullPath, {
          type: 'file',
          content: content
        });
        
        return this.textEncoder.encode(content);
      } catch (error) {
        console.error('Error reading file from server:', error);
        throw error;
      }
    },

    readdir: async (path: string): Promise<string[]> => {
      const fullPath = `${this.workdir}/${path}`;
    
      // First check local cache
      const cachedEntry = this.getFileFromPath(fullPath);
      if (cachedEntry && cachedEntry.type === 'directory' && cachedEntry.children) {
        return Array.from(cachedEntry.children.keys());
      }
    
      // If not in cache, fetch from server
      try {
        const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/oss/tree?prefix=${path}`, {
          credentials: 'include'
        });
        
        const data = await response.json() as OSSTreeResponse;
        if (!data.success) {
          throw new Error(data.message);
        }
    
        // Filter and process paths to get only the files in the requested directory
        const files = data.tree
        .filter(filePath => filePath.startsWith(path)) // Only include files under requested path
        .map(filePath => filePath.slice(path.length + 1)) // Remove prefix path
        .filter(Boolean); // Remove empty strings
    
        // Update cache with the directory structure
        const children = new Map<string, FileSystemEntry>();
        files.forEach(relativePath => {
          // If the name contains a slash, it's a directory
          const parts = relativePath.split('/');
          const firstPart = parts[0];
          
          if (parts.length > 1) {
            // It's a path with subdirectories
            children.set(relativePath, { type: 'file' });
            // Also add the directory entry if it doesn't exist
            if (!children.has(firstPart)) {
              children.set(firstPart, {
                type: 'directory',
                children: new Map()
              });
            }
          } else {
            // It's a direct file/directory in current path
            children.set(firstPart, { type: 'file' });
          }
        });
    
        // Update cache
        this.updateFileSystem(fullPath, {
          type: 'directory',
          children: children
        });
    
        return Array.from(children.keys());
      } catch (error) {
        console.error('Error reading directory from server:', error);
        throw error;
      }
    },

    mkdir: async (path: string, options?: { recursive?: boolean }): Promise<void> => {
      const fullPath = `${this.workdir}/${path}`;

      // Check if directory already exists
      const existingEntry = this.getFileFromPath(fullPath);
      if (existingEntry) {
        if (existingEntry.type === 'directory') {
          // Directory already exists, return silently
          return;
        } else {
          // Path exists but is a file
          throw new Error(`Cannot create directory '${path}': File exists`);
        }
      }

      // If recursive option is not set and parent directory doesn't exist, throw error
      if (!options?.recursive) {
        const parentPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
        const parentEntry = this.getFileFromPath(parentPath);
        if (!parentEntry || parentEntry.type !== 'directory') {
          throw new Error(`Cannot create directory '${path}': No such file or directory`);
        }
      }

      // Create directory and any necessary parent directories
      const parts = fullPath.split('/').filter(p => p.length > 0);
      let current = this.fileSystem;
      
      for (const part of parts) {
        if (!current.has(part)) {
          current.set(part, {
            type: 'directory',
            children: new Map()
          });
        }
        const entry = current.get(part);
        if (entry?.type !== 'directory') {
          throw new Error(`Cannot create directory '${path}': Path exists and is not a directory`);
        }
        current = entry.children!;
      }
    }
  };

  private async ensureSSHSession(): Promise<void> {
    if (!this.sshSession) {
      this.sshSession = await this.initTerminal();
    }
  }

  async initTerminal(): Promise<Terminal> {
    console.log('==========initTerminal ========', this.wsServer, this.authToken)
    const ws = new WebSocket(this.wsServer + '?Authorization=' + this.authToken,['tty']);


    const terminalId = Math.random().toString(36).substring(2, 15);
    
    // 等待 WebSocket 连接建立
    await new Promise((resolve, reject) => {
      ws.onopen = () => {
        // 使用保存的 authToken
        const msg = JSON.stringify({ 
          AuthToken: '',//this.authToken, 
          columns: 80, 
          rows: 40
        });
        ws.send(this.textEncoder.encode(msg));
        resolve(undefined);
      };
      ws.onerror = reject;
    });

    // 添加发送数据的辅助方法
    const sendData = (data: string | Uint8Array) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      if (typeof data === 'string') {
        const payload = new Uint8Array(data.length * 3 + 1);
        payload[0] = this.Command.INPUT.charCodeAt(0);
        const stats = this.textEncoder.encodeInto(data, payload.subarray(1));
        ws.send(payload.subarray(0, (stats.written as number) + 1));
      } else {
        const payload = new Uint8Array(data.length + 1);
        payload[0] = this.Command.INPUT.charCodeAt(0);
        payload.set(data, 1);
        ws.send(payload);
      }
    };
    
    // 保存 Command 和 textDecoder 的引用
    const { Command, textDecoder } = this;
    
    const output = new ReadableStream<string>({
      start(controller) {
        ws.onmessage = (event) => {
          try {
            if (event.data instanceof Blob) {
              event.data.arrayBuffer().then(buffer => {
                try {
                  const data = new Uint8Array(buffer);
                  if (data.length > 0) {
                    const cmd = String.fromCharCode(data[0]);
                    const payload = data.subarray(1);
                    
                    switch (cmd) {
                      case Command.OUTPUT:
                        const text = textDecoder.decode(payload);
                        controller.enqueue(text);
                        break;
                        
                      case Command.SET_WINDOW_TITLE:
                        const title = textDecoder.decode(payload);
                        break;
                        
                      case Command.SET_PREFERENCES:
                        try {
                          const prefs = JSON.parse(textDecoder.decode(payload));
                        } catch (e) {
                          console.warn('Failed to parse preferences:', e);
                        }
                        break;
                        
                      default:
                        console.warn('Unknown command:', cmd);
                    }
                  }
                } catch (error) {
                  console.error('Error processing binary WebSocket message:', error);
                  controller.error(error);
                }
              }).catch(error => {
                console.error('Error reading Blob data:', error);
                controller.error(error);
              });
            } else if (typeof event.data === 'string') {
              controller.enqueue(event.data);
            }
          } catch (error) {
            console.error('Error in WebSocket message handler:', error)
          }
        };
        ws.onclose = () => controller.close();
        ws.onerror = (e) => controller.error(e);
      }
    });

    const input = new WritableStream<string>({
      write(chunk) {
        if (ws.readyState === WebSocket.OPEN) {
          sendData(chunk);
        }
      }
    });

    const terminal: Terminal = {
      id: terminalId,
      input,
      output,
      ws,
      kill: () => {
        ws.close();
        this.terminals.delete(terminalId);
      },
      resize: (cols: number, rows: number) => {
        if (ws.readyState === WebSocket.OPEN) {
          const resizeData = new TextEncoder().encode(JSON.stringify({ columns: cols, rows }));
          const payload = new Uint8Array(resizeData.length + 1);
          payload[0] = this.Command.RESIZE_TERMINAL.charCodeAt(0);
          payload.set(resizeData, 1);
          ws.send(payload);
        }
      },
      createdAt: Date.now(),
      exec_sh_server: async (command: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          const payload = new Uint8Array(command.length * 3 + 2); // +2 for command byte and newline
          payload[0] = this.Command.INPUT.charCodeAt(0);
          const stats = this.textEncoder.encodeInto(command + '\n', payload.subarray(1));
          ws.send(payload.subarray(0, (stats.written as number) + 1));
        }
      },
      pause: () => {
        if (ws.readyState === WebSocket.OPEN) {
          const payload = new Uint8Array(1);
          payload[0] = this.Command.PAUSE.charCodeAt(0);
          ws.send(payload);
        }
      },
      resume: () => {
        if (ws.readyState === WebSocket.OPEN) {
          const payload = new Uint8Array(1);
          payload[0] = this.Command.RESUME.charCodeAt(0);
          ws.send(payload);
        }
      },
      interrupt: () => {
        if (ws.readyState === WebSocket.OPEN) {
          // Send Ctrl+C (ASCII code 3)
          const interruptData = new Uint8Array([this.Command.INPUT.charCodeAt(0), 3]);
          ws.send(interruptData);
        }
      }
    };

    this.terminals.set(terminalId, terminal);
    
    // 发送初始化命令
    const writer = input.getWriter();
    await writer.write('cd project\n');
    writer.releaseLock();
    
    return terminal;
  }

  async spawn(command: string, args: string[] = []): Promise<{
    exit: Promise<number>;
    output: Promise<string>;
  }> {
    await this.ensureSSHSession();
    
    const fullCommand = `${command} ${args.join(' ')}`;
    
    return new Promise((resolve) => {
      if (!this.sshSession) {
        resolve({
          exit: Promise.resolve(1),
          output: Promise.resolve('No SSH session available')
        });
        return;
      }

      // 只需要发送命令
      if (this.sshSession.ws.readyState === WebSocket.OPEN) {
        const payload = new Uint8Array(fullCommand.length * 3 + 2);
        payload[0] = this.Command.INPUT.charCodeAt(0);
        const stats = this.textEncoder.encodeInto(fullCommand + '\n', payload.subarray(1));
        this.sshSession.ws.send(payload.subarray(0, (stats.written as number) + 1));
        
        // 立即返回，输出会通过 shell.ts 的管道处理
        resolve({
          exit: Promise.resolve(0),
          output: Promise.resolve('')
        });
      } else {
        resolve({
          exit: Promise.resolve(1),
          output: Promise.resolve('WebSocket not connected')
        });
      }
    });
  }

  async syncToExternalMap(externalMap: Map<string, string>): Promise<void> {
    const syncDirectory = async (
      current: Map<string, FileSystemEntry>,
      path: string = ''
    ) => {
      for (const [name, entry] of current.entries()) {
        const fullPath = path ? `${path}/${name}` : `/${name}`;
        if (entry.type === 'file' && entry.content !== undefined) {
          externalMap.set(fullPath, entry.content);
        } else if (entry.type === 'directory' && entry.children) {
          await syncDirectory(entry.children, fullPath);
        }
      }
    };

    await syncDirectory(this.fileSystem);
  }

  private updateFileSystem(path: string, entry: FileSystemEntry): void {
    // console.log('==========updateFileSystem ========', path, entry)
    const parts = path.split('/').filter(p => p.length > 0);
    let current = this.fileSystem;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current.has(part)) {
        current.set(part, {
          type: 'directory',
          children: new Map()
        });
      }
      const dirEntry = current.get(part);
      if (dirEntry?.type !== 'directory') {
        throw new Error(`${parts.slice(0, i + 1).join('/')} is not a directory`);
      }
      current = dirEntry.children!;
    }

    const name = parts[parts.length - 1];
    current.set(name, entry);
    // console.log('==========updateFileSystem ========', this.fileSystem)
  }

  private getFileFromPath(path: string): FileSystemEntry | undefined {
    const parts = path.split('/').filter(p => p.length > 0);
    let current = this.fileSystem;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const dirEntry = current.get(parts[i]);
      if (!dirEntry || dirEntry.type !== 'directory') return undefined;
      current = dirEntry.children!;
    }

    // console.log('==========current ========', path,current)
    
    return current.get(parts[parts.length - 1]);
  }

  // Add terminal management methods
  public getTerminal(terminalId: string): Terminal | undefined {
    return this.terminals.get(terminalId);
  }

  public getAllTerminals(): Terminal[] {
    return Array.from(this.terminals.values());
  }

  public killTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      terminal.kill();
      return true;
    }
    return false;
  }

  public killAllTerminals(): void {
    this.terminals.forEach(terminal => terminal.kill());
    this.terminals.clear();
    this.sshSession = null; 
  }

  // Add cleanup method
  public cleanup(): void {
    this.killAllTerminals();
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    // 在热更新时不清理文件系统缓存
    if (!import.meta.hot) {
      this.fileSystem.clear();
      this.pendingSyncs = [];
    }
    this.sshSession = null;
  }

  async writeFile(path: string, content: string) {
    try {
      const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/oss/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key: path,
          content: content
        }),
        credentials: 'include'
      });
      
      const data = await response.json() as APIResponse;
      if (!data.success) {
        throw new Error(data.message);
      }
      return true;
    } catch (error) {
      console.error('Error writing file:', error);
      throw error;
    }
  }

  async readFile(path: string): Promise<string> {
    try {
      const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/oss/download${path}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error(`Failed to read file: ${response.statusText}`);
      }
      
      return await response.text();
    } catch (error) {
      console.error('Error reading file:', error);
      throw error;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const fullPath = `${this.workdir}/${path}`
    try {
      const response = await fetch(`${API_SERVER}/api/${this.apiPrefix}/oss/tree?prefix=${path}`, {
        credentials: 'include'
      });
      
      const data = await response.json() as OSSTreeResponse;
      if (!data.success) {
        throw new Error(data.message);
      }
  
      // Filter and process paths to get only the files in the requested directory
      const files = data.tree
      .filter(filePath => filePath.startsWith(path)) // Only include files under requested path
      .map(filePath => filePath.slice(path.length + 1)) // Remove prefix path
      .filter(Boolean); // Remove empty strings

  

      // Update cache with the directory structure
      const children = new Map<string, FileSystemEntry>();
      files.forEach(relativePath => {
        // If the name contains a slash, it's a directory
        const parts = relativePath.split('/');
          const firstPart = parts[0];
          
          if (parts.length > 1) {
            // It's a path with subdirectories
            children.set(relativePath, { type: 'file' });
            // Also add the directory entry if it doesn't exist
            if (!children.has(firstPart)) {
              children.set(firstPart, {
                type: 'directory',
                children: new Map()
              });
            }
          } else {
            // It's a direct file/directory in current path
            children.set(firstPart, { type: 'file' });
          }
      });
  
      // Update cache
      this.updateFileSystem(fullPath, {
        type: 'directory',
        children: children
      });

  
      return files//Array.from(children.keys());
    } catch (error) {
      console.error('Error reading directory from server:', error);
      throw error;
    }
  }

  public async importDir(sourcePath: string): Promise<void> {
    try {
        // Get the directory tree from OSS
        const files = await this.readdir(sourcePath);
        
        // Process each file/directory
        for (const relativePath of files) {
            const fullPath = `${sourcePath}/${relativePath}`;
            
            // Skip .gitkeep files
            if (relativePath.endsWith('/.gitkeep')) continue;
            
            // If path ends with /, it's a directory
            if (relativePath.endsWith('/')) {
                // Create directory in local filesystem
                await this.fs.mkdir(relativePath.slice(0, -1), { recursive: true });
            } else {
                // It's a file - read its content and write to local filesystem
                try {
                    const content = await this.readFile(fullPath);
                    await this.fs.writeFile(relativePath, content);
                } catch (error) {
                    console.error(`Error importing file ${fullPath}:`, error);
                }
            }
        }
    } catch (error) {
        console.error('Error importing directory:', error);
        throw error;
    }
  }

  public async importDirFromServer(sourcePath: string): Promise<void> {
    try {
      // Get the directory tree from OSS
      const files = await this.readdir(sourcePath);
      
      // Process each file/directory
      for (const relativePath of files) {
        const fullPath = `${sourcePath}/${relativePath}`;
        
        // Skip .gitkeep files
        if (relativePath.endsWith('/.gitkeep')) continue;
        
        // If path ends with /, it's a directory
        if (relativePath.endsWith('/')) {
          // Create directory in local filesystem only
          const dirPath = relativePath.slice(0, -1);
          const fullDirPath = `${this.workdir}/${dirPath}`;
          
          // Update local filesystem structure without server sync
          this.updateFileSystem(fullDirPath, {
            type: 'directory',
            children: new Map()
          });
        } else {
          // It's a file - read its content and update local filesystem only
          try {
            const content = await this.readFile(fullPath);
            const fullFilePath = `${this.workdir}/${relativePath}`;
            
            // Update local filesystem without server sync
            this.updateFileSystem(fullFilePath, {
              type: 'file',
              content: content
            });
          } catch (error) {
            console.error(`Error importing file ${fullPath}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error importing directory from server:', error);
      throw error;
    }
  }
} 