import { Context, Session } from 'koishi'

export class AutoMute {
  private mutePeriod: string = '23-7'
  private recentActivity = new Map<string, number>()
  private muteStatus = new Map<string, boolean>()
  private memberHooks = new Map<string, () => void>()
  private scheduleTimer?: NodeJS.Timeout
  private checkTimer?: NodeJS.Timeout

  constructor(
    private context: Context,
    private targetGroups: string[],
    private validate: (session: Session, groups: string[], admin?: boolean) => boolean
  ) {
    const timeFrame = this.parsePeriod()
    if (timeFrame) this.planSchedule(timeFrame)
  }

  private planSchedule(timeFrame: { start: number; end: number }): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer)
    const currentTime = new Date()
    const currentHour = currentTime.getHours() + currentTime.getMinutes() / 60
    const isActive = timeFrame.start > timeFrame.end
      ? currentHour >= timeFrame.start || currentHour < timeFrame.end
      : currentHour >= timeFrame.start && currentHour < timeFrame.end

    const targetDate = new Date()
    const hourValue = isActive ? timeFrame.end : timeFrame.start
    const finalHour = Math.floor(hourValue)
    const finalMinute = Math.round((hourValue - finalHour) * 60)
    targetDate.setHours(finalHour, finalMinute, 0, 0)
    if (targetDate <= currentTime) targetDate.setDate(targetDate.getDate() + 1)
    const delayTime = targetDate.getTime() - currentTime.getTime()

    if (isActive) {
      this.checkActivity()
      this.checkTimer = setInterval(() => this.checkActivity(), 5 * 60 * 1000)
      this.scheduleTimer = setTimeout(() => this.endMute(), delayTime)
    } else {
      this.scheduleTimer = setTimeout(() => this.startMute(), delayTime)
    }
  }

  private startMute(): void {
    const timeFrame = this.parsePeriod()
    if (!timeFrame) return
    this.checkActivity()
    this.checkTimer = setInterval(() => this.checkActivity(), 5 * 60 * 1000)
    this.planSchedule(timeFrame)
  }

  private async endMute(): Promise<void> {
    const { targetGroups, muteStatus } = this
    if (this.checkTimer) clearInterval(this.checkTimer)
    for (const groupId of targetGroups) {
      if (muteStatus.get(groupId)) await this.toggleMute(groupId, false)
    }
    const timeFrame = this.parsePeriod()
    if (timeFrame) this.planSchedule(timeFrame)
  }

  private async checkActivity(): Promise<void> {
    const { targetGroups, muteStatus, recentActivity } = this
    const timeThreshold = Date.now() - 15 * 60 * 1000
    for (const groupId of targetGroups) {
      const lastTime = recentActivity.get(groupId) ?? 0
      if (!muteStatus.get(groupId) && lastTime < timeThreshold) {
        await this.toggleMute(groupId, true)
      }
    }
  }

  public async recordActivity(session: Session): Promise<void> {
    if (this.validate(session, this.targetGroups, true)) {
      this.recentActivity.set(session.guildId!, Date.now())
    }
  }

  private parsePeriod(): { start: number; end: number } | null {
    const { mutePeriod } = this
    const stringMatch = mutePeriod.match(/^(\d{1,2}(?:\.\d{1,2})?)-(\d{1,2}(?:\.\d{1,2})?)$/)
    if (!stringMatch) return null
    const startHour = parseFloat(stringMatch[1])
    const endHour = parseFloat(stringMatch[2])
    if (isNaN(startHour) || isNaN(endHour) || startHour < 0 || startHour >= 24 || endHour < 0 || endHour >= 24) return null
    return { start: startHour, end: endHour }
  }

  private async toggleMute(groupId: string, muteState: boolean): Promise<void> {
    const { muteStatus, memberHooks, recentActivity } = this
    const adapterBot = this.context.bots.find(bot => bot.platform === 'onebot')
    if (!adapterBot) return
    await (adapterBot as any).internal.setGroupWholeBan(Number(groupId), muteState).catch(() => {})
    muteStatus.set(groupId, muteState)

    if (muteState) {
      if (!memberHooks.has(groupId)) {
        const hookDispose = this.context.on('guild-member-added', async session => {
          if (session.guildId === groupId && muteStatus.get(groupId)) {
            await session.send('本群现在处于宵禁中，寻求帮助的请明早再来吧。').catch(() => {})
          }
        })
        memberHooks.set(groupId, hookDispose)
      }
      await adapterBot.sendMessage(groupId, '宵禁时间到！时间已经不早了，解决问题请明早再来吧').catch(() => {})
    } else {
      memberHooks.get(groupId)?.()
      memberHooks.delete(groupId)
      recentActivity.delete(groupId)
    }
  }

  public clearResource(): void {
    const { memberHooks } = this
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer)
    if (this.checkTimer) clearInterval(this.checkTimer)
    memberHooks.forEach(dispose => dispose())
    memberHooks.clear()
  }
}
