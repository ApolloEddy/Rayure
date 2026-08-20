import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

interface WallpaperProperty {
  order: number
  text: string
  type: string
  value: unknown
  min?: number
  max?: number
  editable?: boolean
}

interface WallpaperProject {
  description: string
  file: string
  general: {
    properties: Record<string, WallpaperProperty>
    localization: Record<string, Record<string, string>>
  }
  title: string
  type: string
}

async function readProject(): Promise<{ project: WallpaperProject, raw: string }> {
  const raw = await readFile(new URL('../public/project.json', import.meta.url), 'utf8')
  return { project: JSON.parse(raw) as WallpaperProject, raw }
}

test('project.json declares an official-compatible self-contained Web wallpaper', async () => {
  const { project } = await readProject()
  assert.equal(project.type, 'web')
  assert.equal(project.file, 'index.html')
  assert.equal(project.title, 'Rayure')
  assert.ok(project.description.length > 0)

  const properties = project.general.properties
  assert.deepEqual(Object.keys(properties), ['accentcolor', 'companionport', 'modelscale', 'showstatus'])
  assert.deepEqual(properties.accentcolor, {
    order: 1,
    text: 'ui_rayure_accent_color',
    type: 'color',
    value: '0.4039215686 0.9098039216 0.9764705882',
  })
  assert.deepEqual(properties.companionport, {
    order: 2,
    text: 'ui_rayure_companion_port',
    type: 'slider',
    value: 32145,
    min: 1024,
    max: 65535,
    editable: true,
  })
  assert.deepEqual(properties.modelscale, {
    order: 3,
    text: 'ui_rayure_model_scale',
    type: 'slider',
    value: 100,
    min: 25,
    max: 200,
    editable: true,
  })
  assert.deepEqual(properties.showstatus, {
    order: 4,
    text: 'ui_rayure_show_status',
    type: 'bool',
    value: true,
  })
})

test('all property labels are translated in English and Simplified Chinese', async () => {
  const { project } = await readProject()
  const localization = project.general.localization
  assert.deepEqual(Object.keys(localization).sort(), ['en-us', 'zh-chs'])

  for (const property of Object.values(project.general.properties)) {
    assert.match(property.text, /^ui_[a-z0-9_]+$/u)
    assert.ok(localization['en-us']?.[property.text], `missing English token ${property.text}`)
    assert.ok(localization['zh-chs']?.[property.text], `missing Simplified Chinese token ${property.text}`)
  }
})

test('project metadata contains no private model path, model payload or Workshop-only flag', async () => {
  const { project, raw } = await readProject()
  assert.equal('official' in project, false)
  assert.equal('workshopid' in project, false)
  assert.doesNotMatch(raw, /StereoModelPlugin|2086|胡桃|\.pmx|\.fbx|\.blend|[A-Za-z]:[\\/]/iu)
})
