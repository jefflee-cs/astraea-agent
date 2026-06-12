import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillFrontmatter } from './frontmatter'
import { loadSkills, _setSkillDirsForTest } from './loadSkillsDir'
import { skillToCommand } from './toCommand'

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'astraea-skills-'))
  tmps.push(d)
  return d
}
function writeSkill(skillsDir: string, name: string, content: string) {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

afterEach(() => {
  _setSkillDirsForTest({})
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})

test('frontmatter: scalar / boolean / inline array / block array', () => {
  const { frontmatter, body } = parseSkillFrontmatter(
    [
      '---',
      'description: review code',
      'when_to_use: when user says review',
      'allowed-tools: [Read, Grep, Bash]',
      'user-invocable: false',
      'disable-model-invocation: true',
      'paths:',
      '  - "**/*.sql"',
      '  - src/**',
      '---',
      '# Body here',
      'do the thing',
    ].join('\n'),
  )
  expect(frontmatter.description).toBe('review code')
  expect(frontmatter.whenToUse).toBe('when user says review')
  expect(frontmatter.allowedTools).toEqual(['Read', 'Grep', 'Bash'])
  expect(frontmatter.userInvocable).toBe(false)
  expect(frontmatter.modelInvocable).toBe(false) // disable-model-invocation:true
  expect(frontmatter.paths).toEqual(['**/*.sql', 'src/**'])
  expect(body.trim()).toBe('# Body here\ndo the thing')
})

test('frontmatter: defaults — both gates open when unspecified', () => {
  const { frontmatter } = parseSkillFrontmatter('---\ndescription: x\n---\nbody')
  expect(frontmatter.userInvocable).toBe(true)
  expect(frontmatter.modelInvocable).toBe(true)
})

test('frontmatter: no frontmatter block degrades gracefully', () => {
  const { frontmatter, body } = parseSkillFrontmatter('just a body, no fm')
  expect(frontmatter.description).toBeUndefined()
  expect(body).toBe('just a body, no fm')
})

test('loadSkills: bare .md is skipped, only subdir+SKILL.md counts', () => {
  const user = tmp()
  writeSkill(user, 'good', '---\ndescription: good skill\n---\nbody')
  writeFileSync(join(user, 'loose.md'), '---\ndescription: nope\n---\n')
  _setSkillDirsForTest({ userDir: user })
  const { unconditional } = loadSkills('/nonexistent-cwd')
  expect(unconditional.map(s => s.name)).toEqual(['good'])
})

test('loadSkills: paths buckets into conditional', () => {
  const user = tmp()
  writeSkill(user, 'plain', '---\ndescription: plain\n---\nb')
  writeSkill(user, 'sql', '---\ndescription: sql\npaths: ["**/*.sql"]\n---\nb')
  _setSkillDirsForTest({ userDir: user })
  const { unconditional, conditional } = loadSkills('/nope')
  expect(unconditional.map(s => s.name)).toEqual(['plain'])
  expect(conditional.map(s => s.name)).toEqual(['sql'])
})

test('loadSkills: user beats project on name collision (first-wins)', () => {
  const user = tmp()
  const proj = tmp()
  const projSkills = join(proj, '.astraea', 'skills') // projectRoot override is the root
  writeSkill(user, 'dup', '---\ndescription: from-user\n---\nb')
  writeSkill(projSkills, 'dup', '---\ndescription: from-project\n---\nb')
  writeSkill(projSkills, 'projonly', '---\ndescription: proj-only\n---\nb')
  _setSkillDirsForTest({ userDir: user, projectRoot: proj })
  const { unconditional } = loadSkills(proj)
  const dup = unconditional.find(s => s.name === 'dup')!
  expect(dup.frontmatter.description).toBe('from-user')
  expect(dup.source).toBe('user')
  expect(unconditional.find(s => s.name === 'projonly')?.source).toBe('project')
})

test('skillToCommand: getPrompt injects body + args, strips frontmatter', async () => {
  const user = tmp()
  writeSkill(user, 'greet', '---\ndescription: greet\nallowed-tools: [Read]\nmodel: x\n---\n# Greet\nsay hi')
  _setSkillDirsForTest({ userDir: user })
  const { unconditional } = loadSkills('/nope')
  const cmd = skillToCommand(unconditional[0]!)
  expect(cmd.type).toBe('prompt')
  expect(cmd.allowedTools).toEqual(['Read'])
  expect(cmd.model).toBe('x')
  const blocks = await cmd.getPrompt('arg1')
  expect(blocks[0]!.text).toContain('# Greet')
  expect(blocks[0]!.text).toContain('say hi')
  expect(blocks[0]!.text).toContain('Arguments:** arg1')
  expect(blocks[0]!.text).not.toContain('description:')
})
