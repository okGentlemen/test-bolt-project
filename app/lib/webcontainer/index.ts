import { WebContainerSim } from './WebContainerSim';

// ���������Ľӿ�
interface WebContainerContext {
  loaded: boolean;
}

// ���������ģ�ʹ�� hot data ����״̬
export const webcontainerContext: WebContainerContext = (import.meta.hot?.data
  .webcontainerContext as WebContainerContext) ?? {
  loaded: false,
};

// ���������ĵ� hot data
if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

// ��ʼ�� webcontainer
export const webcontainer: Promise<WebContainerSim> =
  import.meta.hot?.data.webcontainer ??
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

// �� HMR ʱ����ʵ��
if (import.meta.hot) {
  import.meta.hot.data.webcontainer = webcontainer;
}
