import type { WebContainerSim } from '~/lib/webcontainer/WebContainerSim';
import { getEncoding } from 'istextorbinary';
import { file } from 'jszip';
import { map, type MapStore } from 'nanostores';
import { Buffer } from 'node:buffer';
import * as nodePath from 'node:path';
import { bufferWatchEvents } from '~/utils/buffer';
import { WORK_DIR } from '~/utils/constants';
import { computeFileModifications } from '~/utils/diff';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';

const logger = createScopedLogger('FilesStore');

const utf8TextDecoder = new TextDecoder('utf8', { fatal: true });

export interface File {
  type: 'file';
  content: string | Uint8Array;
  isBinary: boolean;
}

export interface Folder {
  type: 'folder';
}

type Dirent = File | Folder;

export type FileMap = Record<string, Dirent | undefined>;

export class FilesStore {
  #webcontainer: Promise<WebContainerSim>;
  #watcherInterval: NodeJS.Timeout | null = null;

  /**
   * Tracks the number of files without folders.
   */
  #size = 0;

  /**
   * @note Keeps track all modified files with their original content since the last user message.
   * Needs to be reset when the user sends another message and all changes have to be submitted
   * for the model to be aware of the changes.
   */
  #modifiedFiles: Map<string, string> = import.meta.hot?.data.modifiedFiles ?? new Map();

  /**
   * Map of files that matches the state of WebContainer.
   */
  files: MapStore<FileMap> = import.meta.hot?.data.files ?? map({});

  get filesCount() {
    return this.#size;
  }

  constructor(webcontainerPromise: Promise<WebContainerSim>) {
    this.#webcontainer = webcontainerPromise;

    if (import.meta.hot) {
      import.meta.hot.data.files = this.files;
      import.meta.hot.data.modifiedFiles = this.#modifiedFiles;
    }

    this.#init();
  }

  getFile(filePath: string) {
    const dirent = this.files.get()[filePath];

    if (dirent?.type !== 'file') {
      return undefined;
    }

    return dirent;
  }

  getFileModifications() {
    return computeFileModifications(this.files.get(), this.#modifiedFiles);
  }

  resetFileModifications() {
    this.#modifiedFiles.clear();
  }

  async saveFile(filePath: string, content: string) {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = nodePath.relative(webcontainer.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, write '${relativePath}'`);
      }

      const oldContent = this.getFile(filePath)?.content;

      if (!oldContent) {
        unreachable('Expected content to be defined');
      }

      await webcontainer.fs.writeFile(relativePath, content);

      if (!this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.set(filePath, oldContent);
      }

      // we immediately update the file and don't rely on the `change` event coming from the watcher
      this.files.setKey(filePath, { type: 'file', content, isBinary: false });

      logger.info('File updated');
    } catch (error) {
      logger.error('Failed to update file content\n\n', error);

      throw error;
    }
  }

  async ensureDirectory(filePath: string) {
    const webcontainer = await this.#webcontainer;
    const dirname = nodePath.dirname(filePath)
    if (dirname === '.') return
    if (dirname.length === 0) return

    try {
      await webcontainer.fs?.readdir(dirname)
    } catch (error) {
      // Directory doesn't exist, create it recursively
      await webcontainer.fs?.mkdir(dirname, { recursive: true })
    }
  }

  async createFile(filePath: string, content: string | Uint8Array, isUpload: boolean = false) {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = isUpload ? filePath : nodePath.relative(webcontainer.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, write '${relativePath}'`);
      }

      console.log('==========createFile=', filePath, content)
      await webcontainer.fs.writeFile(relativePath, content);

      if (!this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.set(filePath, '-');
      }

      // 判断内容类型
      const isBinary = content instanceof Uint8Array;
      let fileContent;
      
      if (!isBinary) {
        fileContent = content as string;
      }else{
        fileContent = content as Uint8Array;
      }

      console.log('==========fileContent=', filePath, isBinary)
      // 更新文件存储
      this.files.setKey(filePath, { 
        type: 'file', 
        content: fileContent, 
        isBinary 
      });

      logger.info('File uploaded');
    } catch (error) {
      logger.error('Failed to upload file content\n\n', error);
      throw error;
    }
  }

  async #init() {
    if (this.#watcherInterval) {
      clearInterval(this.#watcherInterval);
      this.#watcherInterval = null;
    }

    const webcontainer = await this.#webcontainer;
    
    this.#watcherInterval = setInterval(async () => {
      const currentFiles = new Map<string, string>();
      await webcontainer.syncToExternalMap(currentFiles);

      // console.log('==========currentFiles ========', currentFiles)  
      // console.log('==========this.files.get() ========', this.files.get())
      
      // 比较文件变化并触发相应事件
      for (const [path, content] of currentFiles) {
        const existingFile = this.files.get()[path];
        if (!existingFile) {
          // 新文件
          this.#processEventBuffer([[{
            type: 'add_file',
            path,
            buffer: new TextEncoder().encode(content)
          }]]);
        } else if (existingFile.type === 'file' && existingFile.content !== content) {
          // 文件变化
          this.#processEventBuffer([[{
            type: 'change',
            path,
            buffer: new TextEncoder().encode(content)
          }]]);
        }
      }
      
      // 检查删除的文件
      for (const path of Object.keys(this.files.get())) {
        if (!currentFiles.has(path)) {
          this.#processEventBuffer([[{
            type: 'remove_file',
            path,
            buffer: undefined
          }]]);
        }
      }
    }, 1000); // 每秒检查一次变化
  }

  #processEventBuffer(events: Array<[events: PathWatcherEvent[]]>) {
    const watchEvents = events.flat(2);

    for (const { type, path, buffer } of watchEvents) {
      // 使用 path.normalize 来标准化路径
      const sanitizedPath = nodePath.normalize(path).replace(/\/+$/g, '');
      const workdirRelativePath = nodePath.relative(WORK_DIR, sanitizedPath);

      switch (type) {
        case 'add_dir': {
          // 创建目录时，确保父目录也存在
          const parentPath = nodePath.dirname(sanitizedPath);
          if (parentPath !== '.' && !this.files.get()[parentPath]) {
            this.files.setKey(parentPath, { type: 'folder' });
          }
          this.files.setKey(sanitizedPath, { type: 'folder' });
          break;
        }
        case 'remove_dir': {
          this.files.setKey(sanitizedPath, undefined);

          for (const [direntPath] of Object.entries(this.files)) {
            if (direntPath.startsWith(sanitizedPath)) {
              this.files.setKey(direntPath, undefined);
            }
          }

          break;
        }
        case 'add_file':
        case 'change': {
          if (type === 'add_file') {
            this.#size++;
          }

          let content = '';

          /**
           * @note This check is purely for the editor. The way we detect this is not
           * bullet-proof and it's a best guess so there might be false-positives.
           * The reason we do this is because we don't want to display binary files
           * in the editor nor allow to edit them.
           */
          const isBinary = isBinaryFile(buffer);

          if (!isBinary) {
            content = this.#decodeFileContent(buffer);
          }

          this.files.setKey(sanitizedPath, { type: 'file', content, isBinary });

          break;
        }
        case 'remove_file': {
          this.#size--;
          this.files.setKey(sanitizedPath, undefined);
          break;
        }
        case 'update_directory': {
          // we don't care about these events
          break;
        }
      }
    }
  }

  #decodeFileContent(buffer?: Uint8Array) {
    if (!buffer || buffer.byteLength === 0) {
      return '';
    }

    try {
      return utf8TextDecoder.decode(buffer);
    } catch (error) {
      console.log(error);
      return '';
    }
  }

  destroy() {
    if (this.#watcherInterval) {
      clearInterval(this.#watcherInterval);
      this.#watcherInterval = null;
    }
  }
}

function isBinaryFile(buffer: Uint8Array | undefined) {
  if (buffer === undefined) {
    return false;
  }

  return getEncoding(convertToBuffer(buffer), { chunkLength: 100 }) === 'binary';
}

/**
 * Converts a `Uint8Array` into a Node.js `Buffer` by copying the prototype.
 * The goal is to  avoid expensive copies. It does create a new typed array
 * but that's generally cheap as long as it uses the same underlying
 * array buffer.
 */
function convertToBuffer(view: Uint8Array): Buffer {
  const buffer = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

  Object.setPrototypeOf(buffer, Buffer.prototype);

  return buffer as Buffer;
}
