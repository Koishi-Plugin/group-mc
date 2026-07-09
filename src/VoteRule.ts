import { Session } from 'koishi'

const GROUP_LIST: Record<number, string> = {
  1: '633640264', 2: '203232161', 3: '201034984', 4: '533529045', 5: '744304553',
  6: '282845310', 7: '482624681', 8: '991620626', 9: '657677715', 10: '775084843'
}

export class VoteRule {
  private activeVotes = new Map<string, { guildId: string, guildName: string, targetId: string,
    targetName: string, messageId: string, duration: number, approvers: Set<string>, rejecters: Set<string> }>()
  constructor(private checkPermission: (session: Session, groups: string[], requireAdmin?: boolean) => boolean) {}

  registerCommands(root: any) {
    root.subcommand('vote <id:number> <targetId:string>')
      .option('time', '-t <time:number>', { fallback: 60 })
      .option('kick', '-k')
      .action(async ({ session, options }: { session: Session, options: any }, id: number, targetId: string) => {
        const guildId = GROUP_LIST[id]
        if (session.guildId !== '978519342' || targetId === session.selfId || this.activeVotes.has(`${guildId}-${targetId}`) || !this.checkPermission(session, ['978519342'], false)) return
        const duration = options.kick ? 0 : options.time
        const [memberInfo, guildInfo] = await Promise.all([session.bot.getGuildMember(guildId, targetId).catch(() => ({})), session.bot.getGuild(guildId).catch(() => ({}))]) as any[]
        const targetName = memberInfo.nick || memberInfo.username
        const sentMessage = await session.bot.sendMessage('978519342', `用户: ${targetName}(${targetId})\n群组: ${guildInfo.name}(${guildId})\n操作: ${duration > 0 ? `禁言 ${duration} 分钟` : '踢出群聊'}\n请使用"y/n"回复本消息以投票`)
        if (!sentMessage || (Array.isArray(sentMessage) && !sentMessage.length)) return
        this.activeVotes.set(`${guildId}-${targetId}`, { guildId, guildName: guildInfo.name, targetId, targetName, messageId: String(Array.isArray(sentMessage) ? sentMessage[0] : sentMessage), duration, approvers: new Set(), rejecters: new Set() })
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
    const isApproved = voteData.approvers.size >= 3
    const isRejected = voteData.rejecters.size >= 1
    if (isApproved || isRejected) {
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
    this.activeVotes.clear()
  }
}
