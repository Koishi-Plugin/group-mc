import { Context, Session } from 'koishi'

export class AutoMute {
  public recordActivity: (session: Session) => Promise<void>
  public clearResource: () => void

  constructor(context: Context, targetGroups: string[], adminList: string[], timeRange: string) {
    const [start, end] = timeRange.split(/[-~]/).map(v => parseInt(v.trim()))
    const recentActivity = new Map<string, number>()
    const muteStatus = new Map<string, boolean>()
    const memberHooks = new Map<string, () => void>()
    let pollingTimer: NodeJS.Timeout | null = null

    const toggleMute = async (groupId: string, muteState: boolean) => {
      muteStatus.set(groupId, muteState)
      const bot = context.bots.find(b => b.platform === 'onebot') || context.bots[0]
      if (bot) {
        try { await bot.internal.setGroupWholeBan(Number(groupId), muteState) } catch {}
        if (muteState) {
          if (!memberHooks.has(groupId)) {
            memberHooks.set(groupId, context.on('guild-member-added', (session) => {
              if (session.guildId === groupId && muteStatus.get(groupId)) session.send('本群正在宵禁。想解决问题的话，请明天再来吧').catch(() => {})
            }))
          }
          bot.sendMessage(groupId, '宵禁咯~还有问题的话，明天再来吧').catch(() => {})
        } else {
          memberHooks.get(groupId)?.()
          memberHooks.delete(groupId)
          recentActivity.delete(groupId)
        }
      }
    }

    const onTick = () => {
      const now = Date.now()
      for (const groupId of targetGroups) {
        const isMuted = !!muteStatus.get(groupId)
        if (!isMuted && now - (recentActivity.get(groupId) ?? 0) > 900000) toggleMute(groupId, true)
      }
    }

    const startPolling = () => {
      if (!pollingTimer) { pollingTimer = setInterval(onTick, 60000); onTick() }
    }

    const stopPolling = () => {
      if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null }
      for (const groupId of targetGroups) if (muteStatus.get(groupId)) toggleMute(groupId, false)
    }

    const masterTimer = setInterval(() => {
      const h = new Date().getHours()
      const isMuteTime = start > end ? (h >= start || h < end) : (h >= start && h < end)
      if (isMuteTime) {
        startPolling()
      } else {
        stopPolling()
      }
    }, 60000)

    const initH = new Date().getHours()
    if (start > end ? (initH >= start || initH < end) : (initH >= start && initH < end)) startPolling()

    this.recordActivity = async (session) => { if (targetGroups.includes(session.guildId!) && adminList.includes(session.userId!)) recentActivity.set(session.guildId!, Date.now()) }
    this.clearResource = () => {
      clearInterval(masterTimer)
      if (pollingTimer) clearInterval(pollingTimer)
      memberHooks.forEach(dispose => dispose())
      memberHooks.clear()
    }
  }
}
