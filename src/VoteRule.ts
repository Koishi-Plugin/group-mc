import { Context, h, Session } from 'koishi'

interface VotePoll {
  session: Session
  targetGuildId: string
  targetId: string
  targetName: string
  messageId: string
  duration: number
  approveSet: Set<string>
  rejectSet: Set<string>
  pollTimer?: NodeJS.Timeout
}

export class VoteRule {
  private voteMap = new Map<string, VotePoll>()
  private voteThreshold: string = '3:1'
  private voteTimeout: number = 0
  private controlGroup = '978519342'
  private groupMapping: Record<number, string> = {
    1: '633640264',
    2: '203232161',
    3: '201034984',
    4: '533529045',
    5: '744304553',
    6: '282845310',
    7: '482624681',
    8: '991620626',
    9: '657677715',
    10: '775084843'
  }

  constructor(
    private context: Context,
    private validate: (session: Session, groups: string[], admin?: boolean) => boolean
  ) {}

  registerCommands(root: any): void {
    root.subcommand('vote <id:number> <targetId:string> [time:number]', '投票踢人或禁言')
      .action(async ({ session }: { session: Session }, id: number, targetId: string, time?: number) => {
        if (session.guildId !== this.controlGroup) return
        if (!this.validate(session, [this.controlGroup], true)) return
        const targetGuildId = this.groupMapping[id]
        if (!targetGuildId) return '参数错误。ID 必须是 1-10 之间的数字。'
        if (!targetId) return '参数错误。格式：vote <ID> <用户ID> [时间]'

        return this.startVote(session, targetGuildId, targetId, time)
      })
  }

  private finishVote(pollKey: string, pollData: VotePoll, resultType: 'approve' | 'reject' | 'timeout', replySession?: Session, prefixString = '') {
    const { voteMap } = this
    if (pollData.pollTimer) clearTimeout(pollData.pollTimer)
    voteMap.delete(pollKey)

    const { session, targetGuildId, targetId, targetName, duration } = pollData
    if (!session.bot) return

    const sendMessage = (messageText: string) =>
      replySession
        ? replySession.send(prefixString + (prefixString ? '\n' : '') + messageText).catch(() => {})
        : session.bot.sendMessage(this.controlGroup, messageText).catch(() => {})

    if (resultType === 'timeout') return sendMessage(`投票超时，未对 ${targetName} 执行操作`)
    if (resultType === 'reject') return sendMessage(`投票否决，未对 ${targetName} 执行操作`)

    const actionTask = duration > 0
      ? session.bot.muteGuildMember(targetGuildId, targetId, duration * 60000)
      : session.bot.kickGuildMember(targetGuildId, targetId)

    actionTask
      .then(() => sendMessage(`投票通过，已在群 ${targetGuildId} 中${duration > 0 ? `禁言${duration}分钟` : '踢出'} ${targetName}`))
      .catch((e) => sendMessage(`投票通过，但执行操作失败：${e.message || '未知错误'}`))
  }

  public async startVote(session: Session, targetGuildId: string, targetId: string, time?: number): Promise<void | string> {
    const { voteMap, voteTimeout, voteThreshold } = this
    const { selfId } = session

    if (targetId === selfId) return '不能对机器人发起投票'
    const pollKey = `${targetGuildId}-${targetId}`
    if (voteMap.has(pollKey)) return '该用户的投票正在进行中'

    const finalDuration = time && time > 0 ? time : (time === 0 ? 0 : 60)
    const targetUser = await session.bot.getGuildMember(targetGuildId, targetId).catch(() => ({} as any))
    const targetName = targetUser?.nick || targetUser?.username || targetId
    const targetGuild = await session.bot.getGuild(targetGuildId).catch(() => ({} as any))
    const guildName = targetGuild?.name || targetGuildId

    const limitParts = voteThreshold.split(':').map(Number)
    const approveLimit = limitParts[0]
    const rejectLimit = limitParts[1]

    const alertMessage = `发起投票：\n目标群：${guildName} (${targetGuildId})\n目标用户：${targetName} (${targetId})\n操作：${finalDuration > 0 ? `禁言${finalDuration}分钟` : '踢出'}\n有效期：${voteTimeout > 0 ? `${voteTimeout}分钟` : '无限制'}\n回复此消息投票: y/同意(${approveLimit}) | n/拒绝(${rejectLimit})`

    const pollData: VotePoll = {
      session,
      targetGuildId,
      targetId,
      targetName,
      messageId: '',
      duration: finalDuration,
      approveSet: new Set(),
      rejectSet: new Set()
    }

    const sendResult = await session.bot.sendMessage(this.controlGroup, alertMessage).catch(() => {})
    const messageId = (Array.isArray(sendResult) ? sendResult[0] : sendResult) || ''
    if (!messageId) return '发送投票消息失败'

    pollData.messageId = messageId

    if (voteTimeout > 0) {
      pollData.pollTimer = setTimeout(() => {
        const currentPoll = voteMap.get(pollKey)
        if (!currentPoll) return
        if (currentPoll.approveSet.size >= approveLimit) this.finishVote(pollKey, currentPoll, 'approve')
        else if (currentPoll.rejectSet.size >= rejectLimit) this.finishVote(pollKey, currentPoll, 'reject')
        else this.finishVote(pollKey, currentPoll, 'timeout')
      }, voteTimeout * 60000)
    }

    voteMap.set(pollKey, pollData)
  }

  public async checkMessage(session: Session): Promise<void> {
    const { voteMap, voteThreshold } = this
    const { userId, quote, guildId, content } = session
    if (!userId || !quote?.id || !guildId || guildId !== this.controlGroup) return

    const activePoll = [...voteMap.entries()].find(([, data]) => data.messageId === quote.id)
    if (!activePoll) return

    const [pollKey, pollData] = activePoll
    const textContent = content?.trim().toLowerCase() || ''
    const isApprove = ['y', 'yes', '同意'].includes(textContent)
    const isReject = ['n', 'no', '拒绝'].includes(textContent)

    if (!isApprove && !isReject) return

    if (isApprove) {
      if (pollData.approveSet.has(userId)) return
      pollData.rejectSet.delete(userId)
      pollData.approveSet.add(userId)
    } else {
      if (pollData.rejectSet.has(userId)) return
      pollData.approveSet.delete(userId)
      pollData.rejectSet.add(userId)
    }

    const limitParts = voteThreshold.split(':').map(Number)
    const approveLimit = limitParts[0]
    const rejectLimit = limitParts[1]

    session.send(h.quote(quote.id) + `支持：${pollData.approveSet.size}/${approveLimit} | 反对：${pollData.rejectSet.size}/${rejectLimit}`)
      .then(messageIds => {
        this.context.setTimeout(() => {
          messageIds.forEach(msgId => {
            if (msgId && session.guildId) session.bot.deleteMessage(session.guildId, msgId).catch(() => {})
          })
        }, 60000)
      }).catch(() => {})

    if (pollData.approveSet.size >= approveLimit) {
      this.finishVote(pollKey, pollData, 'approve', session, h.quote(quote.id).toString())
    } else if (pollData.rejectSet.size >= rejectLimit) {
      this.finishVote(pollKey, pollData, 'reject', session, h.quote(quote.id).toString())
    }
  }

  public clearResource(): void {
    const { voteMap } = this
    voteMap.forEach(poll => poll.pollTimer && clearTimeout(poll.pollTimer))
    voteMap.clear()
  }
}
