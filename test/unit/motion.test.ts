import { expect, test } from 'claude-code/testing'

import { dotFrame, duckFrame, duckPoseAt, stampFrame, stampRaster, tween } from '../../src/ui/motion'
import { duckLogo, duckPixels, duckPose } from '../../src/ui/raster'

const SHADES = [0xfbbf24, 0xf59e0b, 0xd97706, 0xb45309]

test('dotFrame breathes through the four amber shades', () => {
  expect(dotFrame(0).color).toBe(0xfbbf24)
  expect(dotFrame(800).color).toBe(0xb45309)
  expect(dotFrame(1600).color).toBe(0xfbbf24)
  for (let t = 0; t < 3200; t += 50) expect(SHADES).toContain(dotFrame(t).color)
})

test('stampFrame reveals over the first 1000 ms and never shrinks', () => {
  const len = Array.from('✦ DEBRIEFED ✦').length
  expect(stampFrame(0, 'done').visible).toBe(0)
  expect(stampFrame(1000 / 1500, 'done').visible).toBe(len)
  expect(stampFrame(1, 'failed').text).toBe('✕ WENT DARK ✕')
  for (const kind of ['done', 'failed', 'killed'] as const) {
    const max = Array.from(stampFrame(1, kind).text).length
    let prev = 0
    for (let i = 0; i <= 100; i++) {
      const v = stampFrame(i / 100, kind).visible
      expect(v).toBeGreaterThanOrEqual(prev)
      expect(v).toBeLessThanOrEqual(max)
      prev = v
    }
  }
})

test('duckFrame blinks 150 ms every 4-7 s with glances, deterministically', () => {
  const starts: number[] = []
  const spans: number[] = []
  let glances = 0
  let runStart = -1
  for (let t = 0; t <= 60000; t += 10) {
    const f = duckFrame(t, 7)
    expect(duckFrame(t, 7)).toBe(f)
    if (f !== 'open') {
      if (f !== 'blink') glances++
      if (runStart < 0) {
        runStart = t
        starts.push(t)
      }
    } else if (runStart >= 0) {
      spans.push(t - runStart)
      runStart = -1
    }
  }
  expect(starts.length).toBeGreaterThan(5)
  for (const s of spans) expect(s).toBe(150)
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i]! - starts[i - 1]!
    expect(gap).toBeGreaterThanOrEqual(4000)
    expect(gap).toBeLessThanOrEqual(7000)
  }
  expect(glances).toBeGreaterThan(0)
})

test('duckFrame keeps its schedule at wall-clock times', () => {
  const t0 = 1_791_800_000_000
  const starts: number[] = []
  const spans: number[] = []
  let glances = 0
  let runStart = -1
  let partial = false
  for (let t = t0; t <= t0 + 60000; t += 10) {
    const f = duckFrame(t, 7)
    if (f !== 'open') {
      if (f !== 'blink') glances++
      if (runStart < 0) {
        runStart = t
        partial = t === t0
        if (!partial) starts.push(t)
      }
    } else if (runStart >= 0) {
      if (!partial) spans.push(t - runStart)
      runStart = -1
    }
  }
  expect(starts.length).toBeGreaterThan(5)
  for (const s of spans) expect(s).toBe(150)
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i]! - starts[i - 1]!
    expect(gap).toBeGreaterThanOrEqual(4000)
    expect(gap).toBeLessThanOrEqual(7000)
  }
  expect(glances).toBeGreaterThan(0)
})

test('duckFrame is cheap at wall-clock times', () => {
  const poses = ['open', 'blink', 'glanceLeft', 'glanceRight']
  for (let i = 0; i <= 5000; i++) expect(poses).toContain(duckFrame(1_791_800_000_000 + i * 200, 7))
})

test('tween eases out and clamps', () => {
  expect(tween(0, 100, 0)).toBe(0)
  expect(tween(0, 100, 1)).toBe(100)
  expect(tween(0, 100, 0.5)).toBe(88)
  expect(tween(100, 0, 1)).toBe(0)
  expect(tween(5, 5, 0.3)).toBe(5)
  expect(tween(0, 100, -2)).toBe(0)
  expect(tween(0, 100, 3)).toBe(100)
})

test('duckPose: blink paints the lenses and glints in the brim color, glances move each glint one pixel', () => {
  const open = duckPixels()
  const blink = duckPose('blink')
  expect(blink[6]![1]).toBe(0x94a3b8)
  expect(blink[6]![3]).toBe(0x94a3b8)
  expect(blink[0]).toEqual(open[0])
  const left = duckPose('glanceLeft')
  expect(open[6]![3]).toBe(0x7dd3fc)
  expect(left[6]![2]).toBe(0x7dd3fc)
  expect(left[6]![3]).toBe(0x020617)
  expect(duckPose('glanceRight')[6]![4]).toBe(0x7dd3fc)
  expect(duckLogo('blink').cells).not.toBe(duckLogo().cells)
  expect(duckLogo('blink').key).toBe('duck')
})

test('stampRaster reveals more cells as progress grows and keeps its key', () => {
  expect(stampRaster('a1', 'done', 0).key).toBe('stamp:a1')
  expect(stampRaster('a1', 'done', 0).cells).not.toBe(stampRaster('a1', 'done', 1).cells)
})

test('duckPoseAt on a 200 ms tick never misses a blink', () => {
  const t0 = 1_791_800_000_000
  // every blink start in the first minute must be seen by at least one tick of a 200 ms timer, at any phase
  for (const phase of [0, 50, 100, 150]) {
    let seen = 0
    let blinks = 0
    let wasOpen = true
    for (let t = t0; t < t0 + 60_000; t += 10) {
      const open = duckFrame(t, 7) === 'open'
      if (wasOpen && !open) blinks += 1
      wasOpen = open
    }
    let lastSeen = false
    for (let t = t0 + phase; t < t0 + 60_000; t += 200) {
      const blinking = duckPoseAt(t, 7, 200) !== 'open'
      if (blinking && !lastSeen) seen += 1
      lastSeen = blinking
    }
    expect(seen).toBe(blinks)
  }
})

