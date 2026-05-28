import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppSkill, GlobalHandler } from './skill-types.js';
import { parseSkill } from './skill-parser.js';

export class SkillManager {
  private cache = new Map<string, AppSkill | null>();
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', 'skills'
    );
  }

  /** Get skill for app package name */
  getSkill(appPackage: string): AppSkill | null {
    if (this.cache.has(appPackage)) return this.cache.get(appPackage) ?? null;

    const skillFile = path.join(this.skillsDir, appPackage, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      this.cache.set(appPackage, null);
      return null;
    }

    const markdown = fs.readFileSync(skillFile, 'utf-8');
    const skill = parseSkill(markdown);
    this.cache.set(appPackage, skill);
    return skill;
  }

  /** Find matching global handler for a popup description */
  findGlobalHandler(appPackage: string, popupDescription: string): GlobalHandler | undefined {
    const skill = this.getSkill(appPackage);
    if (!skill) return undefined;
    const desc = popupDescription.toLowerCase();
    return skill.globalHandlers.find(h =>
      desc.includes(h.popup.toLowerCase()) ||
      desc.includes(h.identification.toLowerCase())
    );
  }

  /** Resolve user message to an operation name */
  resolveIntent(appPackage: string, userMessage: string): string | undefined {
    const skill = this.getSkill(appPackage);
    if (!skill) return undefined;
    return skill.intentRouting.find(r =>
      r.keywords.some(kw => userMessage.includes(kw))
    )?.operation;
  }

  /** Invalidate cache */
  invalidate(appPackage: string): void {
    this.cache.delete(appPackage);
  }

  /** Invalidate all cached skills */
  invalidateAll(): void {
    this.cache.clear();
  }
}
