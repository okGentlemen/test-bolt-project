import type { WebContainerSim } from '~/lib/webcontainer/WebContainerSim';
import { atom } from 'nanostores';

export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;
}

export class PreviewsStore {
  #availablePreviews = new Map<number, PreviewInfo>();
  #webcontainer: Promise<WebContainerSim>;
  #checkCounter = 0;
  #hasValidPreview = false;
  
  previews = atom<PreviewInfo[]>([]);

  constructor(webcontainerPromise: Promise<WebContainerSim>) {
    this.#webcontainer = webcontainerPromise;
    this.#init();
  }

  private async checkUrls(urls: string[]): Promise<Record<string, boolean>> {
    try {
      const response = await fetch('/api/validurl', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ urls }),
      });

      const data = await response.json() as { results: Array<{ url: string; isValid: boolean }> };
      return data.results.reduce((acc: Record<string, boolean>, result) => {
        acc[result.url] = result.isValid;
        return acc;
      }, {});
    } catch (error) {
      console.error('Error checking URLs:', error);
      return {};
    }
  }

  async #init() {
    const webcontainer = await this.#webcontainer;
    setInterval(async () => {
      const currentPreviews = this.previews.get();
      
      if (this.#hasValidPreview && this.#checkCounter < 5) {
        this.#checkCounter++;
        return;
      }
      this.#checkCounter = 0;

      const previewServers = webcontainer.previewServers;
      
      const allUrls = currentPreviews.map(p => p.baseUrl);
      const urlStatus = await this.checkUrls(allUrls);

      const validPreviews = currentPreviews.filter(preview => urlStatus[preview.baseUrl]);
      validPreviews.forEach(preview => {
        if (!this.#availablePreviews.has(preview.port)) {
          this.#availablePreviews.set(preview.port, preview);
        }
      });

      this.#hasValidPreview = validPreviews.length > 0;

      currentPreviews.forEach(preview => {
        if (!urlStatus[preview.baseUrl]) {
          this.#availablePreviews.delete(preview.port);
        }
      });

      const existingUrls = new Set(validPreviews.map(p => p.baseUrl));
      const newServers = previewServers.filter(
        server => !existingUrls.has(`http://${server}`)
      );

      if (newServers.length > 0) {
        const newServerUrls = newServers.map(server => `http://${server}`);
        const newUrlStatus = await this.checkUrls(newServerUrls);

        const basePort = 5173;
        newServers.forEach((server) => {
          const baseUrl = `http://${server}`;
          
          if (newUrlStatus[baseUrl] && !existingUrls.has(baseUrl)) {
            let port = basePort;
            while (this.#availablePreviews.has(port)) {
              port++;
            }

            const previewInfo = {
              port,
              ready: true,
              baseUrl,
            };
            this.#availablePreviews.set(port, previewInfo);
            validPreviews.push(previewInfo);
          }
        });
      }

      if (validPreviews.length !== currentPreviews.length || 
          !currentPreviews.every(p => validPreviews.some(v => v.baseUrl === p.baseUrl))) {
        this.previews.set(validPreviews);
      }

    }, 2000);
  }
}
