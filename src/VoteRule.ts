import { Session } from 'koishi'

const GROUP_ID_MAP: Record<number, string> = {
  1: '633640264', 2: '203232161', 3: '201034984', 4: '533529045', 5: '744304553',
  6: '282845310', 7: '482624681', 8: '991620626', 9: '657677715', 10: '775084843',
  11: '1028074835', 12: '1070029541',
}

export class VoteRule {
  private activeVotes = new Map<string, { guildId: string, guildName: string, targetId: string, targetName: string,
    messageId: string, duration: number, approvers: Set<string>, rejecters: Set<string>, timer: NodeJS.Timeout }>()
  constructor(private checkPermission: (session: Session, groups: string[], requireAdmin?: boolean) => boolean, private ratio: string, private allowedListen: string[], private mgmtGroups: string[]) {}

  registerCommands(root: any) {
    root.subcommand('vote <id:number> <targetId:string>', '发起投票')
      .option('time', '-t <time:number>', { fallback: 60 })
      .option('kick', '-k')
      .action(async ({ session, options }: { session: Session, options: any }, id: number, targetId: string) => {
        const guildId = GROUP_ID_MAP[id]
        if (!session.guildId || !this.mgmtGroups.includes(session.guildId) || targetId === session.selfId || this.activeVotes.has(`${guildId}-${targetId}`)) return

        const duration = options.kick ? 0 : options.time
        const [memberInfo, guildInfo] = await Promise.all([session.bot.getGuildMember(guildId, targetId).catch(() => ({})), session.bot.getGuild(guildId).catch(() => ({}))]) as any[]
        const targetName = memberInfo.nick || memberInfo.username || targetId
        const [appReq, rejReq] = this.ratio.split(':').map(Number)
        const sentMessage = await session.bot.sendMessage(session.guildId, `用户: ${targetName}(${targetId})\n群组: ${guildInfo.name}(${guildId})\n操作: ${duration > 0 ? `禁言 ${duration} 分钟` : '踢出群聊'}（${appReq}赞成/${rejReq}否决）\n请对本消息回复"y/n"进行投票`)
        if (!sentMessage || (Array.isArray(sentMessage) && !sentMessage.length)) return
        const voteKey = `${guildId}-${targetId}`
        const timer = setTimeout(() => { if (this.activeVotes.has(voteKey)) { this.activeVotes.delete(voteKey); session.bot.sendMessage(session.guildId!, `已取消对 ${targetName} 的投票`) } }, 21600000)
        this.activeVotes.set(voteKey, { guildId, guildName: guildInfo.name, targetId, targetName, messageId: String(Array.isArray(sentMessage) ? sentMessage[0] : sentMessage), duration, approvers: new Set(), rejecters: new Set(), timer })
      })
    root.subcommand('revoke', '撤回消息')
      .usage('回复指定消息来撤回对应内容。')
      .action(async ({ session }: { session: Session }) => {
        if (!session.quote?.id) return '请回复需要撤回的消息'
        if (!this.checkPermission(session, this.allowedListen, true)) return
        try { await (session as any).onebot.deleteMsg(session.quote.id) } catch (error) {}
      })
  }

  async receiveMessage(session: Session) {
    const messageId = session.quote?.id
    const voteInput = session.content?.trim().toLowerCase()
    if (!session.guildId || !this.mgmtGroups.includes(session.guildId) || !['y', 'n'].includes(voteInput!) || !messageId) return

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
    if (voteData.approvers.size >= appReq || voteData.rejecters.size >= rejReq) {
      const isApproved = voteData.approvers.size >= appReq
      clearTimeout(voteData.timer)
      this.activeVotes.delete(voteKey)
      if (!isApproved) return session.bot.sendMessage(session.guildId, `已放弃对 ${voteData.guildName} 的 ${voteData.targetName} 执行操作`)
      const executionTask = voteData.duration > 0 ? session.bot.muteGuildMember(voteData.guildId, voteData.targetId, voteData.duration * 60000) : session.bot.kickGuildMember(voteData.guildId, voteData.targetId)
      executionTask.then(() => {
        session.bot.sendMessage(session.guildId!, `已对 ${voteData.guildName} 的 ${voteData.targetName} 执行：${voteData.duration > 0 ? `禁言 ${voteData.duration} 分钟` : '踢出群聊'}`)
      }).catch(error => { session.bot.sendMessage(session.guildId!, `对 ${voteData.guildName} 的 ${voteData.targetName} 执行失败: ${error.message}`) })
    }
  }

  clearResource() {
    for (const v of this.activeVotes.values()) clearTimeout(v.timer)
    this.activeVotes.clear()
  }
}
