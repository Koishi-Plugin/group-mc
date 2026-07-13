import { Session } from 'koishi'

const GROUP_ID_MAP: Record<number, string> = {
  1: '633640264', 2: '203232161', 3: '201034984', 4: '533529045', 5: '744304553',
  6: '282845310', 7: '482624681', 8: '991620626', 9: '657677715', 10: '775084843',
  11: '1028074835', 12: '1070029541',
}

export class VoteRule {
  private revokeUsers = new Set<string>()
  private revokeLogs = new Map<string, any[]>()
  private activeVotes = new Map<string, { guildId: string, guildName: string, targetId: string, targetName: string,
    messageId: string, duration: number, approvers: Map<string, string>, rejecters: Map<string, string>, timer: NodeJS.Timeout, isRevoke: boolean }>()
  constructor(private checkPermission: (session: Session, groups: string[], requireAdmin?: boolean) => boolean, private ratio: string, private allowedListen: string[], private mgmtGroups: string[]) {}

  private async sendAndRecall(session: Session, content: string) {
    const msgIds = await session.bot.sendMessage(session.guildId!, content)
    const ids = Array.isArray(msgIds) ? msgIds : [msgIds]
    setTimeout(() => { ids.forEach(id => session.bot.deleteMessage(session.guildId!, id).catch(() => {})) }, 60000)
  }

  registerCommands(root: any) {
    root.subcommand('vote <id:number> <targetId:string>', '发起投票')
      .option('time', '-t <time:number>', { fallback: 60 })
      .option('kick', '-k', '踢出群聊')
      .option('revoke', '-r', '仅撤回')
      .action(async ({ session, options }: { session: Session, options: any }, id: number, targetId: string) => {
        const guildId = GROUP_ID_MAP[id]
        if (!session.guildId || !this.mgmtGroups.includes(session.guildId) || targetId === session.selfId || this.activeVotes.has(`${guildId}-${targetId}`)) return

        const { kick, revoke: isRevoke, time: duration } = options
        const [memberInfo, guildInfo] = await Promise.all([session.bot.getGuildMember(guildId, targetId).catch(() => ({})), session.bot.getGuild(guildId).catch(() => ({}))]) as any[]
        const targetName = memberInfo.name || memberInfo.user?.name || targetId
        const [appReq, rejReq] = this.ratio.split(':').map(Number)
        const actionDesc = isRevoke ? '撤回权限' : (kick ? '踢出群聊' : `禁言${duration}分钟`)
        const sentMessage = await session.bot.sendMessage(session.guildId, `用户: ${targetName}(${targetId})\n群组: ${guildInfo.name}(${guildId})\n操作: ${actionDesc} | 票数：${appReq}:${rejReq}\n\n请使用"y/n"回复本消息以投票`)
        if (!sentMessage || (Array.isArray(sentMessage) && !sentMessage.length)) return
        const voteKey = `${guildId}-${targetId}`
        const timer = setTimeout(() => { if (this.activeVotes.delete(voteKey)) this.sendAndRecall(session, `已取消对 ${targetName} 的投票`) }, 21600000)
        this.activeVotes.set(voteKey, { guildId, guildName: guildInfo.name, targetId, targetName,
          messageId: String(Array.isArray(sentMessage) ? sentMessage[0] : sentMessage), timer,
          duration: kick ? 0 : duration, approvers: new Map(), rejecters: new Map(), isRevoke: !!isRevoke
        })
      })
    root.subcommand('revoke', '撤回消息')
      .usage('回复指定消息来撤回对应内容。')
      .action(async ({ session }: { session: Session }) => {
        if (!session.quote?.id || !session.quote?.user?.id) return this.sendAndRecall(session, '请回复需要撤回的消息')
        if (session.quote.user.id === session.selfId) {
          try { await session.bot.deleteMessage(session.guildId!, session.quote.id) } catch (error) {}
          return
        }
        if (!this.checkPermission(session, this.allowedListen, true)) return
        if (!this.revokeUsers.has(`${session.userId}-${session.guildId}-${session.quote.user.id}`)) return
        this.revokeLogs.get(`${session.guildId}-${session.quote.user.id}`)?.push({ type: 'node', data: { name: session.quote.user.name, uin: session.quote.user.id, content: session.quote.content } })
        try { await (session as any).onebot.deleteMsg(session.quote.id) } catch (error) {}
      })
  }

  async receiveMessage(session: Session) {
    const content = (session.content || '').toLowerCase()
    const isApprove = content.includes('y'), isReject = content.includes('n')
    if (!session.guildId || !this.mgmtGroups.includes(session.guildId) || (!isApprove && !isReject) || !session.quote?.id) return
    const voteEntry = [...this.activeVotes.entries()].find(([_, data]) => data.messageId === String(session.quote?.id))
    if (!voteEntry) return
    const [voteKey, voteData] = voteEntry
    if (isApprove) {
      voteData.rejecters.delete(session.userId!)
      voteData.approvers.set(session.userId!, session.author?.nick || session.author?.name || session.userId!)
    } else {
      voteData.approvers.delete(session.userId!)
      voteData.rejecters.set(session.userId!, session.author?.nick || session.author?.name || session.userId!)
    }

    const [appReq, rejReq] = this.ratio.split(':').map(Number)
    if (voteData.approvers.size >= appReq || voteData.rejecters.size >= rejReq) {
      const isApproved = voteData.approvers.size >= appReq
      clearTimeout(voteData.timer)
      this.activeVotes.delete(voteKey)
      if (!isApproved) return this.sendAndRecall(session, `已放弃对 ${voteData.targetName} 的操作`)
      const targetKey = `${voteData.guildId}-${voteData.targetId}`
      this.revokeLogs.set(targetKey, [])
      voteData.approvers.forEach((_, vId) => this.revokeUsers.add(`${vId}-${targetKey}`))
      setTimeout(async () => {
        const logs = this.revokeLogs.get(targetKey)
        if (logs?.length) for (const gid of this.mgmtGroups) await (session.bot as any).internal.sendGroupForwardMsg(gid, logs).catch(() => {})
        voteData.approvers.forEach((_, vId) => this.revokeUsers.delete(`${vId}-${targetKey}`))
        this.revokeLogs.delete(targetKey)
      }, 300000)
      session.bot.sendMessage(session.guildId!, `已对 ${voteData.targetName} 执行：${voteData.isRevoke ? '撤回权限' : (voteData.duration > 0 ? `禁言${voteData.duration}分钟` : '踢出群聊')}`)
      if (!voteData.isRevoke) {
        const action = voteData.duration > 0  ? session.bot.muteGuildMember(voteData.guildId, voteData.targetId, voteData.duration * 60000) : session.bot.kickGuildMember(voteData.guildId, voteData.targetId)
        action.catch(error => this.sendAndRecall(session, `对 ${voteData.targetName} 的操作失败: ${error.message}`))
      }
    } else {
      const currentVoters = Array.from(isApprove ? voteData.approvers.values() : voteData.rejecters.values()).join(', ')
      this.sendAndRecall(session, `已投${isApprove ? '支持' : '反对'}票，当前：${currentVoters}`)
    }
  }

  clearResource() {
    this.activeVotes.forEach(v => clearTimeout(v.timer))
    this.activeVotes.clear()
    this.revokeUsers.clear()
    this.revokeLogs.clear()
  }
}
