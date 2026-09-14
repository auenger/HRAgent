import assert from 'node:assert/strict'
import test from 'node:test'
import { isRecruitmentUrl } from '../dist/main/platforms.js'

test('recruitment browser only allows the selected HTTPS platform domain', () => {
  assert.equal(isRecruitmentUrl('https://lpt.liepin.com/login', 'liepin'), true)
  assert.equal(isRecruitmentUrl('https://passport.liepin.com/login', 'liepin'), true)
  assert.equal(isRecruitmentUrl('https://www.zhipin.com/web/chat', 'boss'), true)
  assert.equal(isRecruitmentUrl('https://liepin.com.evil.example/login', 'liepin'), false)
  assert.equal(isRecruitmentUrl('http://lpt.liepin.com/login', 'liepin'), false)
  assert.equal(isRecruitmentUrl('https://lpt.liepin.com/login', 'boss'), false)
  assert.equal(isRecruitmentUrl('not a url', 'boss'), false)
})
