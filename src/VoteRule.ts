import { Context, h, Session } from 'koishi'

interface VotePoll {
  session: Session
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
  private targetGroups = ['978519342']

  constructor(
    private context: Context,
    private validate: (session: Session, groups: string[], admin?: boolean) => boolean
  ) {}

  registerCommands(rootCommand: any): void {
    rootCommand.subcommand('vote', '投票踢人或禁言')
      .option('time', '-t <time:number>', { fallback: 60 })
      .option('ban', '-b', { fallback: false })
      .action(({ session, options }: { session: Session; options: { time?: number; ban?: boolean } }) => {
        if (!this.validate(session, this.targetGroups, true)) return
        return this.startVote(session, options)
      })
  }

  private finishVote(pollKey: string, pollData: VotePoll, resultType: 'approve' | 'reject' | 'timeout', replySession?: Session, prefixString = '') {
    const { voteMap, targetGroups } = this
    if (pollData.pollTimer) clearTimeout(pollData.pollTimer)
    voteMap.delete(pollKey)

    const { session, targetId, targetName, duration } = pollData
    const guildId = session.guildId
    if (!session.bot || !guildId) return

    const targetChannel = targetGroups[0]
    const sendMessage = (messageText: string) =>
      replySession
        ? replySession.send(prefixString + (prefixString ? '\n' : '') + messageText).catch(() => {})
        : session.bot.sendMessage(targetChannel, messageText).catch(() => {})

    if (resultType === 'timeout') return sendMessage(`投票超时，未对 ${targetName} 执行操作`)
    if (resultType === 'reject') return sendMessage(`投票否决，未对 ${targetName} 执行操作`)

    const actionTask = duration > 0
      ? session.bot.muteGuildMember(guildId, targetId, duration * 60000)
      : session.bot.kickGuildMember(guildId, targetId)

    actionTask
      .then(() => sendMessage(`投票通过，已${duration > 0 ? `禁言${duration}分钟` : '踢出'} ${targetName}`))
      .catch(() => {})
  }

  public async startVote(session: Session, options: { time?: number; ban?: boolean }): Promise<void> {
    const { voteMap, voteTimeout, voteThreshold, targetGroups } = this
    const { userId, guildId, selfId, quote } = session
    if (!guildId || !userId || !quote?.user?.id) return

    const targetChannel = targetGroups[0]
    if (targetChannel) {
      try {
        await session.bot.getGuildMember(targetChannel, userId)
      } catch {
        return
      }
    }

    const targetId = quote.user.id
    if (targetId === selfId) return
    const pollKey = `${guildId}-${targetId}`
    if (voteMap.has(pollKey)) return

    const finalDuration = options.ban ? 0 : (options.time && options.time > 0 ? options.time : 60)
    const targetUser = await session.bot.getGuildMember(guildId, targetId).catch(() => ({} as any))
    const targetName = targetUser?.nick || quote.user.name || targetId
    const targetGuild = await session.bot.getGuild(guildId).catch(() => ({} as any))
    const guildName = targetGuild?.name || guildId

    const limitParts = voteThreshold.split(':').map(Number)
    const approveLimit = limitParts[0]
    const rejectLimit = limitParts[1]

    const alertMessage = `${guildName} (${guildId})\n${targetName} (${targetId})\n${voteTimeout > 0 ? `${voteTimeout}分钟` : '无限时'}→${finalDuration > 0 ? `禁言${finalDuration}分钟` : '踢出'}\n引用回复: y/同意(${approveLimit}) | n/拒绝(${rejectLimit})`

    const pollData: VotePoll = { session, targetId, targetName, messageId: '', duration: finalDuration, approveSet: new Set(), rejectSet: new Set() }

    if (targetChannel && targetChannel !== guildId) {
      await session.bot.internal.sendGroupForwardMsg(Number(targetChannel), [{ type: 'node', data: { name: targetName, uin: targetId, content: quote.content } }]).catch(() => {})
    }

    const sendResult = await session.bot.sendMessage(targetChannel, alertMessage).catch(() => {})
    const messageId = (Array.isArray(sendResult) ? sendResult[0] : sendResult) || ''
    if (!messageId) return

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
    if (!this.validate(session, this.targetGroups, true)) return

    const { voteMap, voteThreshold, targetGroups } = this
    const { userId, quote, guildId, content } = session
    const targetChannel = targetGroups[0]
    if (!userId || !quote?.id || !guildId || guildId !== targetChannel) return

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

    session.send(h.quote(quote.id) + `支持：${pollData.approveSet.size}/${approveLimit} | 反反对：${pollData.rejectSet.size}/${rejectLimit}`)
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
