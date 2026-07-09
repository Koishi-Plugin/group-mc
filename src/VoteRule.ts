import { Session } from 'koishi'

const GROUP_LIST: Record<number, string> = {
  1: '633640264', 2: '203232161', 3: '201034984', 4: '533529045', 5: '744304553',
  6: '282845310', 7: '482624681', 8: '991620626', 9: '657677715', 10: '775084843'
}

export class VoteRule {
  private activeVotes = new Map<string, { guildId: string, guildName: string, targetId: string, targetName: string,
    messageId: string, duration: number, approvers: Set<string>, rejecters: Set<string>, timer: NodeJS.Timeout }>()
  constructor(private checkPermission: (session: Session, groups: string[], requireAdmin?: boolean) => boolean, private ratio: string) {}

  registerCommands(root: any) {
    root.subcommand('vote <id:number> <targetId:string>', '发起投票')
      .option('time', '-t <time:number>', { fallback: 60 })
      .option('kick', '-k')
      .action(async ({ session, options }: { session: Session, options: any }, id: number, targetId: string) => {
        const guildId = GROUP_LIST[id]
        if (session.guildId !== '978519342' || targetId === session.selfId || this.activeVotes.has(`${guildId}-${targetId}`) || !this.checkPermission(session, ['978519342'], false)) return
        const duration = options.kick ? 0 : options.time
        const [memberInfo, guildInfo] = await Promise.all([session.bot.getGuildMember(guildId, targetId).catch(() => ({})), session.bot.getGuild(guildId).catch(() => ({}))]) as any[]
        const targetName = memberInfo.nick || memberInfo.username
        const [appReq, rejReq] = this.ratio.split(':').map(Number)
        const sentMessage = await session.bot.sendMessage('978519342', `用户: ${targetName}(${targetId})\n群组: ${guildInfo.name}(${guildId})\n操作: ${duration > 0 ? `禁言 ${duration} 分钟` : '踢出群聊'}\n请回复"y/n"投票 (6h有效, 需${appReq}赞成/${rejReq}否决)`)
        if (!sentMessage || (Array.isArray(sentMessage) && !sentMessage.length)) return
        const voteKey = `${guildId}-${targetId}`
        const timer = setTimeout(() => { if (this.activeVotes.has(voteKey)) { this.activeVotes.delete(voteKey); session.bot.sendMessage('978519342', `已取消对 ${targetName} 的投票`) } }, 21600000)
        this.activeVotes.set(voteKey, { guildId, guildName: guildInfo.name, targetId, targetName, messageId: String(Array.isArray(sentMessage) ? sentMessage[0] : sentMessage), duration, approvers: new Set(), rejecters: new Set(), timer })
      })
    root.subcommand('revoke', '撤回消息')
      .usage('回复指定消息来撤回对应内容。')
      .action(async ({ session }: { session: Session }) => {
        if (!session.quote?.id) return '请回复需要撤回的消息'
        const allowedGroups = ['633640264', '203232161', '201034984', '533529045', '744304553', '282845310', '482624681', '991620626', '657677715', '775084843', '1028074835', '1070029541', '666546887', '978054335', '958853931', '978519342']
        const isManager = await session.bot.getGuildMember('978519342', session.userId!).then(() => true).catch(() => false)
        if (!isManager || !this.checkPermission(session, allowedGroups)) return
        try { await (session as any).onebot.deleteMsg(session.quote.id) } catch (error) {}
      })
  }

  async receiveMessage(session: Session) {
    const messageId = session.quote?.id
    const voteInput = session.content?.trim().toLowerCase()
    if (session.guildId !== '978519342' || !['y', 'n'].includes(voteInput!) || !messageId) return
    const voteEntry = [...this.activeVotes.entries()].find(([_, data]) => data.messageId === String(messageId))
    if (!voteEntry) return
    const [voteKey, voteData] = voteEntry
    const currentUserId = session.userId!
    if (voteInput === 'y') {
      voteData.rejecters.delete(currentUserId)
      voteData.approvers.add(currentUserId)
    } else {
      voteData.approvers.delete(currentUserId)
      voteData.rejecters.add(currentUserId)
    }
    const [appReq, rejReq] = this.ratio.split(':').map(Number)
    const isApproved = voteData.approvers.size >= appReq
    const isRejected = voteData.rejecters.size >= rejReq
    if (isApproved || isRejected) {
      clearTimeout(voteData.timer)
      this.activeVotes.delete(voteKey)
      if (isRejected) return session.bot.sendMessage('978519342', `已取消对 ${voteData.guildName}(${voteData.guildId}) 的 ${voteData.targetName}(${voteData.targetId}) 的操作`)
      const executionTask = voteData.duration > 0 ? session.bot.muteGuildMember(voteData.guildId, voteData.targetId, voteData.duration * 60000) : session.bot.kickGuildMember(voteData.guildId, voteData.targetId)
      executionTask.then(() => {
        session.bot.sendMessage('978519342', `已对 ${voteData.guildName}(${voteData.guildId}) 的 ${voteData.targetName}(${voteData.targetId}) 执行：${voteData.duration > 0 ? `禁言 ${voteData.duration} 分钟` : '踢出群聊'}`)
      }).catch(error => {
        session.bot.sendMessage('978519342', `对用户 ${voteData.targetName}(${voteData.targetId}) 执行操作失败: ${error.message}`)
      })
    }
  }

  clearResource() {
    for (const v of this.activeVotes.values()) clearTimeout(v.timer)
    this.activeVotes.clear()
  }
}
