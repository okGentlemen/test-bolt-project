import { WebContainerSim } from './WebContainerSim';

// 定义上下文接口
interface WebContainerContext {
  loaded: boolean;
}

// 创建上下文，使用 hot data 保持状态
export const webcontainerContext: WebContainerContext = (import.meta.hot?.data.webcontainerContext as WebContainerContext) ?? {
  loaded: false,
};

// 保存上下文到 hot data
if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

// 初始化 webcontainer
export let webcontainer: Promise<WebContainerSim> = import.meta.hot?.data.webcontainer ?? 
  new Promise((resolve) => {
    const instance = new WebContainerSim('hc', 'p7');
    
    const initWithRetry = async () => {
      try {
        await instance.initializeDomains();
        webcontainerContext.loaded = true;
 
        resolve(instance);
      } catch (error) {
        console.warn('WebContainer initialization failed, retrying in 3 seconds...', error);
        setTimeout(initWithRetry, 3000);
      }
    };

    initWithRetry();
  });

// 在 HMR 时保存实例
if (import.meta.hot) {
  import.meta.hot.data.webcontainer = webcontainer;
}
