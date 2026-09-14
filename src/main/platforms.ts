export const PLATFORMS = {
  boss: {
    name: 'BOSS 直聘',
    domain: 'zhipin.com',
    pages: {
      login: 'https://login.zhipin.com',
      recommend: 'https://www.zhipin.com/web/chat/recommend',
      messages: 'https://www.zhipin.com/web/chat',
    },
  },
  liepin: {
    name: '猎聘企业端',
    domain: 'liepin.com',
    pages: {
      login: 'https://lpt.liepin.com/login',
      recommend: 'https://lpt.liepin.com/recommend',
      messages: null,
    },
  },
} as const

export type Platform = keyof typeof PLATFORMS
export type RecruitmentPage = 'login' | 'recommend' | 'messages'

export function isRecruitmentUrl(value: string, platform: Platform): boolean {
  try {
    const url = new URL(value)
    const domain = PLATFORMS[platform].domain
    return url.protocol === 'https:'
      && (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  } catch {
    return false
  }
}
