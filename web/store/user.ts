import Values from 'values.js'
import { AppSchema } from '../../common/types/schema'
import { EVENTS, events } from '../emitter'
import { FileInputResult } from '../shared/FileInput'
import { createDebounce, getRootVariable, hexToRgb, storage, setRootVariable } from '../shared/util'
import { api, clearAuth, getAuth, getUserId, isLoggedIn, setAuth } from './api'
import { createStore } from './create'
import { localApi } from './data/storage'
import { usersApi } from './data/user'
import { publish, subscribe } from './socket'
import { toastStore } from './toasts'
import { UI } from '/common/types'
import { defaultUIsettings } from '/common/types/ui'
import type { FindUserResponse } from '/common/horde-gen'
import { AIAdapter } from '/common/adapters'

const BACKGROUND_KEY = 'ui-bg'
export const ACCOUNT_KEY = 'agnai-username'

type ConfigUpdate = Partial<AppSchema.User & { hordeModels?: string[] }>

const fontFaces: { [key in UI.FontSetting]: string } = {
  lato: 'Lato, sans-serif',
  default: 'unset',
}

const [debouceUI] = createDebounce((update: UI.UISettings) => {
  updateTheme(update)
}, 50)

export type UserState = {
  loading: boolean
  error?: string
  loggedIn: boolean
  jwt: string
  profile?: AppSchema.Profile
  user?: AppSchema.User
  ui: UI.UISettings
  current: UI.CustomUI
  background?: string
  metadata: {
    openaiUsage?: number
    hordeStats?: FindUserResponse
  }
  oaiUsageLoading: boolean
  hordeStatsLoading: boolean
  showProfile: boolean
  tiers: AppSchema.SubscriptionTier[]
  tier?: AppSchema.SubscriptionTier
  billingLoading: boolean
  subStatus?: {
    status: 'active' | 'cancelling' | 'cancelled' | 'new'
    tierId: string
    customerId: string
    subscriptionId: string
    priceId: string
    downgrading?: {
      tierId: string
      requestedAt: string
      activeAt: string
    }
  }
}

export const userStore = createStore<UserState>(
  'user',
  init()
)((get, set) => {
  events.on(EVENTS.sessionExpired, () => {
    userStore.logout()
  })

  events.on(EVENTS.init, (init) => {
    userStore.setState({ user: init.user, profile: init.profile })

    if (init.user?._id !== 'anon') {
      userStore.getTiers()
    }

    window.usePipeline = init.user.useLocalPipeline

    /**
     * While introducing persisted UI settings, we'll automatically persist settings that the user has in local storage
     */
    if (!init.user.ui) {
      userStore.saveUI(defaultUIsettings)
    } else {
      userStore.receiveUI(init.user.ui)
    }
  })

  storage.getItem(BACKGROUND_KEY).then((bg) => {
    if (!bg) return
    set({ background: bg })
  })

  return {
    modal({ showProfile }, show?: boolean) {
      return { showProfile: show ?? !showProfile }
    },
    async getProfile() {
      const res = await usersApi.getProfile()
      if (res.error) return toastStore.error(`Failed to get profile`)
      if (res.result) {
        return { profile: res.result }
      }
    },

    async getTiers({ user }) {
      const res = await api.get('/admin/tiers')
      if (res.result) {
        const tier = res.result.tiers.find(
          (tier: AppSchema.SubscriptionTier) => tier._id === user?.sub?.tierId
        )
        return { tiers: res.result.tiers, tier }
      }
    },

    async *startCheckout({ billingLoading }, tierId: string) {
      if (billingLoading) return
      yield { billingLoading: true }
      const callback = location.origin
      const res = await api.post(`/admin/billing/subscribe/checkout`, { tierId, callback })
      yield { billingLoading: false }
      if (res.result) {
        checkout(res.result.sessionUrl)
      }

      if (res.error) {
        toastStore.error(`Could not start checkout: ${res.error}`)
      }
    },
    async *finishCheckout(
      { user, billingLoading },
      sessionId: string,
      state: string,
      onSuccess?: Function
    ) {
      if (billingLoading) return
      yield { billingLoading: true }
      const res = await api.post(`/admin/billing/subscribe/finish`, { sessionId, state })
      yield { billingLoading: false }
      if (res.result && state === 'success') {
        onSuccess?.()
        return {
          user: { ...user!, sub: res.result },
        }
      }

      if (res.error) {
        toastStore.error(`Could not complete checkout: ${res.error}`)
      }
    },
    async *stopSubscription({ billingLoading }) {
      if (billingLoading) return
      yield { billingLoading: true }
      const res = await api.post('/admin/billing/subscribe/cancel')
      yield { billingLoading: false }
      if (res.result) {
        toastStore.normal('Subscription has been stopped')
        userStore.getConfig()
      }

      if (res.error) {
        toastStore.error(`Could not modify subsctiption: ${res.error}`)
      }
    },
    async *resumeSubscription({ billingLoading }) {
      if (billingLoading) return
      yield { billingLoading: true }
      const res = await api.post('/admin/billing/subscribe/resume')
      yield { billingLoading: false }
      if (res.result) {
        toastStore.success('Your subscription has been resumed!')
        userStore.getConfig()
      }

      if (res.error) {
        toastStore.error(`Could not resume subscription: ${res.error}`)
      }
    },

    async *modifySubscription({ billingLoading }, tierId: string) {
      if (billingLoading) return
      yield { billingLoading: true }
      const res = await api.post('/admin/billing/subscribe/modify', { tierId })
      yield { billingLoading: false }

      if (res.result) {
        toastStore.success('Your subscription has been changed')
        userStore.getConfig()
        userStore.subscriptionStatus()
      }

      if (res.error) {
        toastStore.error(`Could not change subscription: ${res.error}`)
      }
    },

    async *validateSubscription({ billingLoading }) {
      if (billingLoading) return
      yield { billingLoading: true }
      const res = await api.post('/admin/billing/subscribe/verify')
      yield { billingLoading: false }
      if (res.result) {
        toastStore.success('You are currently subscribed')
      }

      if (res.error) {
        toastStore.error(res.error)
      }
    },

    async subscriptionStatus() {
      if (!isLoggedIn()) return
      const res = await api.get('/admin/billing/subscribe/status')
      if (res.result) {
        return { subStatus: res.result }
      }
    },

    async getConfig({ ui, tiers }) {
      const res = await usersApi.getConfig()

      if (res.error) return toastStore.error(`Failed to get user config`)
      if (res.result) {
        if (res.result.username) {
          storage.localSetItem(ACCOUNT_KEY, res.result.username)
        }
        window.usePipeline = res.result.useLocalPipeline
        const tier = tiers.find((tier) => tier._id === res.result?.sub?.tierId)
        return { user: res.result, tier }
      }
    },

    async updateProfile(_, profile: { handle: string; avatar?: File }) {
      const res = await usersApi.updateProfile(profile.handle, profile.avatar)
      if (res.error) toastStore.error(`Failed to update profile: ${res.error}`)
      if (res.result) {
        toastStore.success(`Updated profile`)
        return { profile: res.result }
      }
    },

    async updateConfig({ tiers }, config: ConfigUpdate) {
      const res = await usersApi.updateConfig(config)
      if (res.error) toastStore.error(`Failed to update config: ${res.error}`)
      if (res.result) {
        window.usePipeline = res.result.useLocalPipeline
        const tier = tiers.find((tier) => tier._id === res.result?.sub?.tierId)
        toastStore.success(`Updated settings`)
        return { user: res.result, tier }
      }
    },

    async updatePartialConfig({ tiers }, config: ConfigUpdate) {
      const res = await usersApi.updatePartialConfig(config)
      if (res.error) toastStore.error(`Failed to update config: ${res.error}`)
      if (res.result) {
        const tier = tiers.find((tier) => tier._id === res.result?.sub?.tierId)
        window.usePipeline = res.result.useLocalPipeline
        toastStore.success(`Updated settings`)
        return { user: res.result, tier }
      }
    },

    async updateService(_, service: AIAdapter, update: any, onDone?: (err?: any) => void) {
      const res = await usersApi.updateServiceConfig(service, update)
      if (res.error) {
        onDone?.(res.error)
        toastStore.error(`Failed to update service config: ${res.error}`)
        return
      }
      if (res.result) {
        toastStore.success('Updated service settings')
        onDone?.()
        return { user: res.result }
      }
    },

    async changePassword(_, password: string, onSuccess?: Function) {
      const res = await api.post('/user/password', { password })
      if (res.error) return toastStore.error('Failed to change password')
      if (res.result) {
        toastStore.success(`Successfully changed password`)
        onSuccess?.()
      }
    },

    async remoteLogin(_, onSuccess: (token: string) => void) {
      const res = await api.post('/user/login/callback')
      if (res.result) {
        onSuccess(res.result.token)
      }

      if (res.error) {
        toastStore.error(`Could not authenticate: ${res.error}`)
      }
    },

    async *login(_, username: string, password: string, onSuccess?: (token: string) => void) {
      yield { loading: true }

      const res = await api.post('/user/login', { username, password })
      yield { loading: false }
      if (res.error) {
        return toastStore.error(`Authentication failed`)
      }

      setAuth(res.result.token)
      storage.localSetItem(ACCOUNT_KEY, username)

      yield {
        loading: false,
        loggedIn: true,
        user: res.result.user,
        profile: res.result.profile,
        jwt: res.result.token,
      }

      if (res.result.user.ui) {
        yield { ui: res.result.user.ui }
      }

      onSuccess?.(res.result.token)
      publish({ type: 'login', token: res.result.token })
      events.emit(EVENTS.loggedIn)
    },
    async *register(
      _,
      newUser: { handle: string; username: string; password: string },
      onSuccess?: () => void
    ) {
      yield { loading: true }

      const res = await api.post('/user/register', newUser)
      yield { loading: false }
      if (res.error) {
        return toastStore.error(`Failed to register: ${res.error}`)
      }

      setAuth(res.result.token)

      yield {
        loggedIn: true,
        user: res.result.user,
        profile: res.result.profile,
        jwt: res.result.token,
      }

      toastStore.success('Welcome to Agnaistic')
      onSuccess?.()
      publish({ type: 'login', token: res.result.token })
    },
    async *logout() {
      clearAuth()
      publish({ type: 'logout' })
      const ui = await getUIsettings(true)
      yield {
        jwt: '',
        profile: undefined,
        user: undefined,
        loggedIn: false,
        showProfile: false,
        ui,
      }
      events.emit(EVENTS.loggedOut)
    },

    async *deleteAccount() {
      const res = await api.method('delete', '/user/my-account')
      if (res.result) {
        toastStore.error('Account deleted')
        userStore.logout()
      }

      if (res.error) {
        toastStore.error(`Could not delete account: ${res.error}`)
      }
    },

    async saveUI({ ui }, update: Partial<UI.UISettings>) {
      // const mode = update.mode ? update.mode : ui.mode
      const next: UI.UISettings = { ...ui, ...update }
      const mode = next.mode
      const current = next[next.mode]

      await usersApi.updateUI({ ...next, [mode]: current })

      try {
        await updateTheme({ ...next, [mode]: current })
      } catch (e: any) {
        toastStore.error(`Failed to save UI settings: ${e.message}`)
      }

      return { ui: next, current, [mode]: current }
    },

    async saveCustomUI({ ui }, update: Partial<UI.CustomUI>) {
      const current = { ...ui[ui.mode], ...update }

      const next = { ...ui, [ui.mode]: current }
      await usersApi.updateUI(next)

      try {
        await updateTheme(next)
      } catch (e: any) {
        toastStore.error(`Failed to save UI settings: ${e.message}`)
      }

      return { ui: next, current }
    },

    async tryCustomUI({ ui }, update: Partial<UI.CustomUI>) {
      const prop = ui.mode === 'light' ? 'light' : 'dark'
      const current = { ...ui[prop], ...update }
      const next = { ...ui, current, [prop]: current }
      await updateTheme(next)
      return next
    },

    tryUI({ ui }, update: Partial<UI.UISettings>) {
      const mode = update.mode || ui.mode
      const current = ui[mode]
      const next = { current, ...ui, ...update }
      debouceUI(next)
      return { ui: next }
    },

    async receiveUI(_, update: UI.UISettings) {
      const current = update[update.mode]
      await updateTheme(update)
      return { ui: update, current }
    },

    setBackground(_, file: FileInputResult | null) {
      try {
        if (!file) {
          setBackground(null)
          return { background: undefined }
        }

        setBackground(file.content)
        return { background: file.content }
      } catch (e: any) {
        toastStore.error(`Failed to set background: ${e.message}`)
      }
    },

    async deleteKey(
      { user },
      kind: 'novel' | 'horde' | 'openai' | 'scale' | 'claude' | 'third-party' | 'elevenlabs'
    ) {
      const res = await usersApi.deleteApiKey(kind)
      if (res.error) return toastStore.error(`Failed to update settings: ${res.error}`)

      if (!user) return
      toastStore.success('Key removed')
      if (kind === 'novel') {
        return { user: { ...user, novelApiKey: '', novelVerified: false } }
      }

      if (kind === 'horde') {
        return { user: { ...user, hordeKey: '', hordeName: '' } }
      }

      if (kind === 'claude') {
        return { user: { ...user, claudeApiKey: '', claudeApiKeySet: false } }
      }

      if (kind === 'third-party') {
        return { user: { ...user, thirdPartyPassword: '' } }
      }

      if (kind === 'elevenlabs') {
        return { user: { ...user, elevenLabsApiKey: '', elevenLabsApiKeySet: false } }
      }

      if (kind === 'openai') {
        return { user: { ...user, oaiKey: '', oaiKeySet: false } }
      }
    },

    async clearGuestState() {
      try {
        const chats = await localApi.loadItem('chats')
        for (const chat of chats) {
          storage.removeItem(`messages-${chat._id}`)
        }

        for (const key in localApi.KEYS) {
          await storage.removeItem(key)
          await localApi.loadItem(key as any)
        }

        toastStore.error(`Guest state successfully reset`)
        userStore.logout()
      } catch (e: any) {
        toastStore.error(`Failed to reset guest state: ${e.message}`)
      }
    },

    async novelLogin(_, key: string, onComplete: (err?: boolean) => void) {
      const res = await usersApi.novelLogin(key)
      if (res.result) {
        toastStore.success('Successfully authenticated with NovelAI')
        onComplete()
        return { user: res.result }
      }

      if (res.error) {
        onComplete(true)
        toastStore.error(`NovelAI login failed: ${res.error}`)
      }
    },

    async createApiKey(_, cb: (err: any, code?: string) => void) {
      const res = await api.post('/user/code')
      if (res.result) {
        cb(null, res.result.code)
      }

      if (res.error) {
        cb(res.error)
      }
    },

    async *hordeStats({ metadata, user }) {
      yield { hordeStatsLoading: true }
      const res = await api.post('/user/services/horde-stats', { key: user?.hordeKey })
      yield { hordeStatsLoading: false }
      if (res.error) {
        toastStore.error(`Could not retrieve usage: ${res.error}`)
        yield { metadata: { ...metadata, openaiUsage: -1 } }
      }

      if (res.result) {
        if (res.result.error) {
          toastStore.warn(`Could not retrieve Horde stats: ${res.result.error}`)
          return
        }

        yield {
          metadata: {
            ...metadata,
            hordeStats: res.result.user,
          },
        }
      }
    },
  }
})

function init(): UserState {
  const existing = getAuth()

  try {
    storage.test()
  } catch (e: any) {
    toastStore.error(`localStorage unavailable: ${e.message}`)
  }

  const ui = getUIsettings()
  updateTheme(ui)

  if (!existing) {
    return {
      loading: false,
      jwt: '',
      loggedIn: false,
      ui,
      background: undefined,
      oaiUsageLoading: false,
      hordeStatsLoading: false,
      metadata: {},
      current: ui[ui.mode] || UI.defaultUIsettings[ui.mode],
      showProfile: false,
      tiers: [],
      billingLoading: false,
    }
  }

  return {
    loggedIn: true,
    loading: false,
    jwt: existing,
    ui,
    background: undefined,
    oaiUsageLoading: false,
    hordeStatsLoading: false,
    metadata: {},
    current: ui[ui.mode] || UI.defaultUIsettings[ui.mode],
    showProfile: false,
    tiers: [],
    billingLoading: false,
  }
}

async function updateTheme(ui: UI.UISettings) {
  storage.localSetItem(getUIKey(), JSON.stringify(ui))
  const root = document.documentElement

  const mode = ui[ui.mode]

  const hex = mode.bgCustom || getSettingColor('--bg-800')
  const colors = mode.bgCustom
    ? new Values(`${hex}`)
        .all(14)
        .map(({ hex }) => '#' + hex)
        .reverse()
    : []

  if (ui.mode === 'dark') {
    colors.reverse()
  }

  const gradients = ui.bgCustomGradient ? getColorShades(ui.bgCustomGradient) : []

  for (let shade = 100; shade <= 1000; shade += 100) {
    const index = shade / 100 - 1
    const num = ui.mode === 'light' ? 1000 - shade : shade

    if (shade <= 900) {
      const color = getRootVariable(`--${ui.theme}-${num}`)
      const colorRgb = hexToRgb(color)
      root.style.setProperty(`--hl-${shade}`, color)
      root.style.setProperty(`--rgb-hl-${shade}`, `${colorRgb?.rgb}`)

      const text = getRootVariable(`--truegray-${900 - (num - 100)}`)
      const textRgb = hexToRgb(text)
      root.style.setProperty(`--text-${shade}`, text)
      root.style.setProperty(`--rgb-text-${shade}`, `${textRgb?.rgb}`)
    }

    const bg = getRootVariable(`--${ui.themeBg}-${num}`)
    const bgValue = colors.length ? colors[index] : bg
    const bgRgb = hexToRgb(getSettingColor(bgValue))
    const gradient = getSettingColor(gradients.length ? colors[index] : bg)

    root.style.setProperty(`--bg-${shade}`, bgValue)
    root.style.setProperty(`--gradient-${shade}`, gradient)
    root.style.setProperty(`--gradient-bg-${shade}`, `linear-gradient(${bgValue}, ${gradient})`)
    root.style.setProperty(`--rgb-bg-${shade}`, `${bgRgb?.rgb}`)
  }

  setRootVariable('text-chatcolor', getSettingColor(mode.chatTextColor || 'text-800'))
  setRootVariable('text-emphasis-color', getSettingColor(mode.chatEmphasisColor || 'text-600'))
  setRootVariable('text-quote-color', getSettingColor(mode.chatQuoteColor || 'text-800'))
  setRootVariable('bot-background', getSettingColor(mode.botBackground || 'bg-800'))
  root.style.setProperty(`--sitewide-font`, fontFaces[ui.font])
}

function getUIsettings(guest = false) {
  const key = getUIKey(guest)
  const json =
    storage.localGetItem(key) ||
    storage.localGetItem('ui-settings') ||
    JSON.stringify(UI.defaultUIsettings)

  const settings: UI.UISettings = JSON.parse(json)
  const theme = (storage.localGetItem('theme') || settings.theme) as UI.ThemeColor
  storage.removeItem('theme')

  if (theme && UI.UI_THEME.includes(theme)) {
    settings.theme = theme
  }

  const ui = { ...UI.defaultUIsettings, ...settings }

  if (!ui.dark.chatEmphasisColor) {
    ui.dark.chatQuoteColor = UI.defaultUIsettings.dark.chatQuoteColor
    ui.light.chatQuoteColor = UI.defaultUIsettings.light.chatQuoteColor
  }

  return ui
}

async function setBackground(content: any) {
  if (content === null) {
    await storage.removeItem(BACKGROUND_KEY)
    return
  }

  await storage.setItem(BACKGROUND_KEY, content)
}

function adjustColor(color: string, percent: number, target = 0) {
  if (color.startsWith('--')) {
    color = getSettingColor(color)
  } else if (!color.startsWith('#')) {
    color = '#' + color
  }

  const step = [0, 0, 0]

  const hex = [1, 3, 5]
    .map((v, i) => {
      const val = parseInt(color.substring(v, v + 2), 16)
      step[i] = target !== 0 ? (val + target) / 100 : 0
      return val
    })
    .map((v, i) => {
      if (target !== 0) return v + percent * step[i]
      return (v * (100 + percent)) / 100
    })
    .map((v) => Math.min(v, 255))
    .map((v) => Math.round(v))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')

  return '#' + hex
}

function getColorShades(color: string) {
  const colors: string[] = [adjustColor(color, -100), color]
  for (let i = 2; i <= 9; i++) {
    const next = adjustColor(color, i * 100)
    colors.push(next)
  }

  return colors
}

export function getSettingColor(color: string) {
  if (!color) return ''
  if (color.startsWith('#')) return color
  return getRootVariable(color)
}

export function getAsCssVar(color: string) {
  if (color.startsWith('--')) return `var(${color})`
  return `var(--${color})`
}

function getUIKey(guest = false) {
  const userId = guest ? 'anon' : getUserId()
  return `ui-settings-${userId}`
}

subscribe('ui-update', { ui: 'any' }, (body) => {
  userStore.receiveUI(body.ui)
})

events.on(EVENTS.tierReceived, (tier: AppSchema.SubscriptionTier) => {
  const { tiers } = userStore.getState()
  const existing = tiers.some((t) => t._id === tier._id)

  const next = existing ? tiers.map((t) => (t._id === tier._id ? tier : t)) : tiers.concat(tier)

  userStore.setState({ tiers: next })
})

async function checkout(sessionUrl: string) {
  const child = window.open(
    sessionUrl,
    `_blank`,
    `width=600,height=1080,scrollbar=yes,top=100,left=100`
  )!

  let success = false
  const interval = setInterval(() => {
    try {
      if (child.closed) {
        clearInterval(interval)
        if (success) {
          userStore.getConfig()
          toastStore.success('Subscription successful!')
        }
        return
      }

      const path = child.location.pathname
      if (!path.includes('/checkout')) return

      const result = path.includes('/success')
      success = result
    } catch (ex) {}
  })
}
