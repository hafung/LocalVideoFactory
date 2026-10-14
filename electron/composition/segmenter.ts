import { Jieba, TfIdf } from '@node-rs/jieba';
import { dict, idf } from '@node-rs/jieba/dict.js';

const jieba = Jieba.withDict(dict);
const tfIdf = TfIdf.withDict(idf);
const punctuation = /^[\p{P}\p{S}\s]+$/u;
const captionJieba = Jieba.withDict(dict);
captionJieba.loadDict(Buffer.from('高级感 100000 n\n无理由退货 100000 v', 'utf8'));
const protectedText = /\d+(?:[.,]\d+)*(?:万元|亿元|小时|分钟|秒钟|毫秒|公斤|厘米|毫米|公里|千米|元|块|天|年|月|日|秒|米|克|岁|个|%|％)|[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/gu;

export interface CaptionPart { text: string; tag: string; startChar: number; endChar: number; lexical: boolean }

/** Retain punctuation and use codepoint offsets, never UTF-16 or UTF-8 offsets. */
export function segmentCaptionText(text: string, dictionary: string[] = []): CaptionPart[] {
  const instance = dictionary.length ? Jieba.withDict(dict) : captionJieba;
  if (dictionary.length) instance.loadDict(Buffer.from(['高级感 100000 n', '无理由退货 100000 v', ...dictionary].join('\n'), 'utf8'));
  const parts: CaptionPart[] = [];
  let offset = 0;
  const append = (value: string, protectedTag?: string) => {
    for (const item of protectedTag ? [{ word: value, tag: protectedTag }] : instance.tag(value, true)) {
      const size = Array.from(item.word).length;
      parts.push({ text: item.word, tag: item.tag, startChar: offset, endChar: offset + size,
        lexical: !punctuation.test(item.word) });
      offset += size;
    }
  };
  let cursor = 0;
  for (const match of text.matchAll(protectedText)) {
    append(text.slice(cursor, match.index));
    append(match[0], /^\d/u.test(match[0]) ? 'm' : 'eng');
    cursor = match.index + match[0].length;
  }
  append(text.slice(cursor));
  if (parts.map(part => part.text).join('') !== text) throw new Error('字幕分词未保留完整原文');
  return parts;
}

export function segmentChinese(text: string): string[] {
  return jieba.cut(text, true).filter(token => token.trim() && !punctuation.test(token));
}

export function extractChineseKeywords(text: string, limit = 5): string[] {
  return tfIdf.extractKeywords(jieba, text, limit)
    .map(item => item.keyword.trim())
    .filter(keyword => keyword.length > 1 && !punctuation.test(keyword));
}

export function loadProjectDictionary(entries: string[]): void {
  const normalized = entries.map(entry => entry.trim()).filter(Boolean);
  if (normalized.length) jieba.loadDict(Buffer.from(normalized.join('\n'), 'utf8'));
}
