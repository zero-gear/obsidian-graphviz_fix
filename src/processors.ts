import { MarkdownPostProcessorContext, normalizePath, TFile } from 'obsidian';
import * as tmp from 'tmp';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';
import { createHash } from 'crypto';
import GraphvizPlugin from './main';
// import {graphviz} from 'd3-graphviz'; => does not work, ideas how to embed d3 into the plugin?

export class Processors {
  plugin: GraphvizPlugin;

  constructor(plugin: GraphvizPlugin) {
    this.plugin = plugin;
  }
  
  imageMimeType = new Map<string, string>([
        ['png', 'image/png'],
        ['svg', 'image/svg+xml']
    ]);

  private extractGraphClasses(source: string): string[] {
    const stringBeforeBrace = source.split('{', 1)[0]?.trim() || '';
    return stringBeforeBrace
      .split(/\s+/)
      .map(token => token.replace(/[^\w-]/g, ''))
      .filter(token => token.length > 0);
  }

  private resolveVaultImagePath(imageHref: string, sourcePath: string): string | null {
    // External/data URLs should be left untouched.
    if (/^(?:[a-z]+:|data:|#)/i.test(imageHref)) {
      return null;
    }

    const href = imageHref.split('#')[0]?.split('?')[0] || imageHref;
    const candidates: string[] = [];

    if (href.startsWith('/')) {
      candidates.push(href.slice(1));
    } else {
      const cleanedHref = href.startsWith('./') ? href.slice(2) : href;
      const sourceDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
      if (sourceDir.length > 0) {
        candidates.push(normalizePath(`${sourceDir}/${cleanedHref}`));
      }
      candidates.push(normalizePath(cleanedHref));
    }

    for (const candidate of candidates) {
      const abstractFile = this.plugin.app.vault.getAbstractFileByPath(candidate);
      if (abstractFile instanceof TFile) {
        return abstractFile.path;
      }
    }
    return null;
  }

  private getImageMimeType(imagePath: string): string {
    const extension = path.extname(imagePath).toLowerCase();
    switch (extension) {
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.gif':
        return 'image/gif';
      case '.webp':
        return 'image/webp';
      case '.svg':
        return 'image/svg+xml';
      default:
        return 'application/octet-stream';
    }
  }

  private async tryBuildDataUriForLocalImage(imageHref: string, sourcePath: string): Promise<string | null> {
    if (/^(?:[a-z]+:|data:|#)/i.test(imageHref)) {
      return null;
    }

    const href = imageHref.split('#')[0]?.split('?')[0] || imageHref;
    const candidatePaths: string[] = [];
    const dotWorkingDirectory = this.getDotWorkingDirectory(sourcePath);
    const adapter = this.plugin.app.vault.adapter as { getFullPath?: (p: string) => string };

    if (href.startsWith('/')) {
      // In Obsidian, "/..." should resolve from vault root, not OS filesystem root.
      const vaultRelativePath = normalizePath(href.slice(1));
      if (adapter.getFullPath) {
        candidatePaths.push(adapter.getFullPath(vaultRelativePath));
      }

      // Backward-compatible fallback: if href is an existing OS absolute path,
      // allow embedding it as a data URI to avoid broken image stubs.
      if (path.isAbsolute(href)) {
        candidatePaths.push(href);
      }
    } else if (dotWorkingDirectory) {
      candidatePaths.push(path.resolve(dotWorkingDirectory, href));
    }

    for (const candidatePath of candidatePaths) {
      try {
        await fs.promises.access(candidatePath, fs.constants.R_OK);
        const imageContent = await fs.promises.readFile(candidatePath);
        const mimeType = this.getImageMimeType(candidatePath);
        return `data:${mimeType};base64,${imageContent.toString('base64')}`;
      } catch (_error) {
        // Ignore inaccessible candidates and continue trying.
      }
    }
    return null;
  }

  private getDotWorkingDirectory(sourcePath: string): string | undefined {
    const adapter = this.plugin.app.vault.adapter as { getFullPath?: (p: string) => string };
    if (!adapter.getFullPath) {
      return undefined;
    }
    const absoluteNotePath = adapter.getFullPath(sourcePath);
    return path.dirname(absoluteNotePath);
  }

  private resolveDotImagePathForGraphviz(imageHref: string): string {
    // Keep external/data/hash references unchanged.
    if (/^(?:[a-z]+:|data:|#)/i.test(imageHref)) {
      return imageHref;
    }

    if (!imageHref.startsWith('/')) {
      // Keep note-relative paths unchanged; dot resolves them from cwd.
      return imageHref;
    }

    // Treat "/..." as vault-root absolute path.
    const adapter = this.plugin.app.vault.adapter as { getFullPath?: (p: string) => string };
    if (!adapter.getFullPath) {
      return imageHref;
    }
    const vaultRelativePath = normalizePath(imageHref.slice(1));
    return adapter.getFullPath(vaultRelativePath);
  }

  private rewriteDotImagePathsForGraphviz(source: string): string {
    let rewritten = source;

    rewritten = rewritten.replace(/(image\s*=\s*")([^"]+)(")/g, (_match, prefix, href, suffix) => {
      return `${prefix}${this.resolveDotImagePathForGraphviz(href)}${suffix}`;
    });
    rewritten = rewritten.replace(/(image\s*=\s*')([^']+)(')/g, (_match, prefix, href, suffix) => {
      return `${prefix}${this.resolveDotImagePathForGraphviz(href)}${suffix}`;
    });
    rewritten = rewritten.replace(/(<IMG\b[^>]*\bSRC\s*=\s*")([^"]+)(")/gi, (_match, prefix, href, suffix) => {
      return `${prefix}${this.resolveDotImagePathForGraphviz(href)}${suffix}`;
    });
    rewritten = rewritten.replace(/(<IMG\b[^>]*\bSRC\s*=\s*')([^']+)(')/gi, (_match, prefix, href, suffix) => {
      return `${prefix}${this.resolveDotImagePathForGraphviz(href)}${suffix}`;
    });

    return rewritten;
  }

  private async writeDotFile(sourceFile: string, dotWorkingDirectory?: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const cmdPath = this.plugin.settings.dotPath;
      const imageFormat = this.plugin.settings.imageFormat;
      const parameters = [ `-T${imageFormat}`, `-Gbgcolor=transparent`, `-Gstylesheet=obs-gviz.css`, sourceFile ];

      console.debug(`Starting dot process ${cmdPath}, ${parameters}`);
      const dotProcess = spawn(cmdPath, parameters, dotWorkingDirectory ? { cwd: dotWorkingDirectory } : undefined);
      const outData: Array<Uint8Array> = [];
      let errData = '';

      dotProcess.stdout.on('data', function (data) {
        outData.push(data);
      });
      dotProcess.stderr.on('data', function (data) {
        errData += data;
      });
      dotProcess.stdin.end();
      dotProcess.on('exit', function (code) {
        if (code !== 0) {
          reject(`"${cmdPath} ${parameters}" failed, error code: ${code}, stderr: ${errData}`);
        } else {
          resolve(Buffer.concat(outData));
        }
      });
      dotProcess.on('error', function (err: Error) {
        reject(`"${cmdPath} ${parameters}" failed, ${err}`);
      });
    });
  }

  private async convertToImage(source: string, sourcePath: string): Promise<Uint8Array> {
    const self = this;
    const dotWorkingDirectory = this.getDotWorkingDirectory(sourcePath);
    return new Promise<Uint8Array>((resolve, reject) => {
      tmp.file(function (err, tmpPath, fd, _/* cleanupCallback */) {
        if (err) reject(err);

        fs.write(fd, source, function (err) {
          if (err) {
            reject(`write to ${tmpPath} error ${err}`);
            return;
          }
          fs.close(fd,
            function (err) {
              if (err) {
                reject(`close ${tmpPath} error ${err}`);
                return;
              }
              return self.writeDotFile(tmpPath, dotWorkingDirectory).then(data => resolve(data)).catch(message => reject(message));
            }
          );
        });
      });
    });
  }

  public async imageProcessor(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const wordsBeforeBrace = this.extractGraphClasses(source);

    try {
      console.debug('Call image processor');
      //make sure url is defined. once the setting gets reset to default, an empty string will be returned by settings
      const sourceForDot = this.rewriteDotImagePathsForGraphviz(source);
      const imageData = await this.convertToImage(sourceForDot, ctx.sourcePath);
      const blobData = new Uint8Array(imageData);
      if (this.plugin.settings.imageFormat === 'svg') {
        const svgText = new TextDecoder().decode(blobData);
        const parser = new DOMParser();
        const parsedSvg = parser.parseFromString(svgText, 'image/svg+xml');
        const svgRoot = parsedSvg.documentElement;

        if (svgRoot.tagName.toLowerCase() !== 'svg') {
          throw new Error('Invalid SVG output from dot executable.');
        }

        const images = Array.from(svgRoot.querySelectorAll('image'));
        for (const imageElement of images) {
          const href = imageElement.getAttribute('href') || imageElement.getAttribute('xlink:href');
          if (!href) {
            continue;
          }
          const vaultPath = this.resolveVaultImagePath(href, ctx.sourcePath);
          if (vaultPath) {
            const resourceUrl = this.plugin.app.vault.adapter.getResourcePath(vaultPath);
            imageElement.setAttribute('href', resourceUrl);
            imageElement.setAttribute('xlink:href', resourceUrl);
            continue;
          }

          const localDataUri = await this.tryBuildDataUriForLocalImage(href, ctx.sourcePath);
          if (localDataUri) {
            imageElement.setAttribute('href', localDataUri);
            imageElement.setAttribute('xlink:href', localDataUri);
          }
        }

        const graphClasses = ['graphviz', ...wordsBeforeBrace].join(' ').trim();
        svgRoot.setAttribute('class', graphClasses);

        // Inline SVG keeps Graphviz URL and tooltip interactivity.
        el.appendChild(document.importNode(svgRoot, true));
      } else {
        const blob = new Blob([ blobData ], {'type': this.imageMimeType.get(this.plugin.settings.imageFormat)});
        const url = window.URL || window.webkitURL;
        const blobUrl = url.createObjectURL(blob);
        const img = document.createElement('img');
        img.setAttribute('class', 'graphviz ' + wordsBeforeBrace.join(' '));
        img.setAttribute('src', blobUrl);
        el.appendChild(img);
      }
    } catch (errMessage) {
      console.error('convert to image error', errMessage);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.appendChild(code);
      code.setText(errMessage);
      el.appendChild(pre);
    }
  }
  
  public async d3graphvizProcessor(source: string, el: HTMLElement, _: MarkdownPostProcessorContext): Promise<void> {
    console.debug('Call d3graphvizProcessor');

    const wordsBeforeBrace = this.extractGraphClasses(source);

    const div = document.createElement('div');
    const graphId = 'd3graph_' + createHash('md5').update(source).digest('hex').substring(0, 6);
    div.setAttr('id', graphId);
    div.setAttr('style', 'text-align: center');
    div.setAttr('class', 'graphviz ' + wordsBeforeBrace.join(" "));
    el.appendChild(div);
    const script = document.createElement('script');
    // graphviz(graphId).renderDot(source); => does not work, ideas how to use it?
    // Besides, sometimes d3 is undefined, so there must be a proper way to integrate d3.
    const escapedSource = source.replaceAll('\\', '\\\\').replaceAll('`','\\`');
    script.text =
      `if( typeof d3 != 'undefined') { 
        d3.select("#${graphId}").graphviz()
        .onerror(d3error)
       .renderDot(\`${escapedSource}\`);
    }
    function d3error (err) {
        d3.select("#${graphId}").html(\`<div class="d3graphvizError"> d3.graphviz(): \`+err.toString()+\`</div>\`);
        console.error('Caught error on ${graphId}: ', err);
    }`;
    el.appendChild(script);
  }
}
