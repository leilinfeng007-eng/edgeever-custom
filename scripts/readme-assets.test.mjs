import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const languages = ["README.md", "README.zh-CN.md", "README.zh-TW.md", "README.es.md",
  "README.de.md", "README.fr.md", "README.ja.md", "README.pl-PL.md", "README.ru.md"];
const readmes = ["README.md", ...languages.map(name => `docs/readme/${name}`)];
const documents = [...readmes, "docs/CONTRIBUTING.md", "docs/CONTRIBUTING.zh-CN.md",
  "docs/source-map.md", "docs/source-map.zh-CN.md"];
const remoteSource = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const localLinks = markdown => [...markdown.matchAll(/(?:\]\(|\b(?:src|href)=["'])([^\s"'<>)]*)/gi)]
  .map(match => match[1]).filter(source => source && !remoteSource.test(source));
const headingIds = markdown => {
  const counts = new Map();
  return [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    const slug = match[1].toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  });
};

describe("README and contributor navigation", () => {
  for (const document of documents) {
    test(`${document} has existing local link and image targets`, () => {
      const file = resolve(repositoryRoot, document);
      const markdown = readFileSync(file, "utf8");
      const sources = localLinks(markdown);
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        const [path, fragment] = source.split("#");
        const target = resolve(dirname(file), decodeURIComponent(path || "."));
        const targetFile = path ? target : file;
        expect(existsSync(targetFile), `${document}: missing ${source}`).toBe(true);
        if (fragment && targetFile.endsWith(".md")) {
          const content = readFileSync(targetFile, "utf8");
          const ids = [...headingIds(content), ...[...content.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1])];
          expect(ids, `${document}: missing fragment ${source}`).toContain(decodeURIComponent(fragment));
        }
        if (/\.(png|svg|webp|jpg|gif)$/i.test(path)) expect(statSync(targetFile).isFile()).toBe(true);
      }
    });
  }
  for (const readme of readmes) {
    test(`${readme} links every other language at its new location`, () => {
      const file = resolve(repositoryRoot, readme);
      const links = localLinks(readFileSync(file, "utf8")).map(link => resolve(dirname(file), link.split("#")[0]));
      for (const language of languages) {
        const target = resolve(repositoryRoot, "docs/readme", language);
        if (target !== file) expect(links).toContain(target);
      }
    });
  }
});
