import { Session } from 'koishi'

const GROUP_ID_MAP: Record<number, string> = {
  1: '633640264', 2: '203232161', 3: '201034984', 4: '533529045', 5: '744304553',
  6: '282845310', 7: '482624681', 8: '991620626', 9: '657677715', 10: '775084843',
  11: '1028074835', 12: '1070029541',
}

export class VoteRule {
  private revokeUsers = new Set<string>()
  private revokeLogs = new Map<string, any[]>()
  private activeVotes = new Map<string, {
    guildId: string
    guildName: string
    targetId: string
    targetName: string
    messageId: string
    duration: number
    approvers: Set<string>
    rejecters: Set<string>
    timer: NodeJS.Timeout
    pollInterval?: NodeJS.Timeout
    isRevoke: boolean
  }>()

  constructor(
    private checkPermission: (session: Session, groups: string[], requireAdmin?: boolean) => boolean,
    private ratio: string,
    private allowedListen: string[],
    private mgmtGroups: string[],
    private voteReaction: boolean
  ) {}

  private async sendAndRecall(session: Session, content: string) {
    const msgIds = await session.bot.sendMessage(session.guildId!, content)
    const ids = Array.isArray(msgIds) ? msgIds : [msgIds]
    setTimeout(() => { ids.forEach((id) => session.bot.deleteMessage(session.guildId!, id).catch(() => {})) }, 60000)
  }

  private async setMsgEmoji(session: Session, msgId: string, emojiId: number) {
    if (!this.voteReaction) return
    try { await (session as any).onebot._request('set_msg_emoji_like', { message_id: msgId, emoji_id: String(emojiId), set: true }) } catch (e) {}
  }

  private async fetchEmojiLikes(session: Session, msgId: string, emojiId: number) {
    const request = async (api: string, params: any) => { try { return await (session as any).onebot._request(api, params) } catch (e) { return {} } }
    let { data } = await request('fetch_emoji_like', { message_id: msgId, emojiId: String(emojiId), emojiType: '1', count: 20, cookie: "" })
    if (!data?.emojiLikesList) {
      const res = await request('get_emoji_likes', { message_id: String(msgId), emoji_id: String(emojiId), count: 0 })
      data = res.data
    }
    const list = data?.emojiLikesList || data?.emoji_like_list || []
    return list.map((u: any) => String(u.tinyId || u.uin || u.user_id))
  }

  private cleanupVote(key: string) {
    const voteData = this.activeVotes.get(key)
    if (voteData) {
      clearTimeout(voteData.timer)
      if (voteData.pollInterval) clearInterval(voteData.pollInterval)
      this.activeVotes.delete(key)
    }
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
        const tips = this.voteReaction ? `请使用"👍/👎"回应本消息以投票` : `请使用"y/n"回复本消息以投票`
        const sentMessage = await session.bot.sendMessage(session.guildId, `用户: ${targetName}(${targetId})\n群组: ${guildInfo.name}(${guildId})\n操作: ${actionDesc} | 票数：${appReq}:${rejReq}\n\n${tips}`)
        if (!sentMessage || (Array.isArray(sentMessage) && !sentMessage.length)) return
        const messageId = String(Array.isArray(sentMessage) ? sentMessage[0] : sentMessage)
        const voteKey = `${guildId}-${targetId}`
        const timer = setTimeout(async () => {
          if (!this.activeVotes.has(voteKey)) return
          if (this.voteReaction) {
            await this.setMsgEmoji(session, messageId, 424)
          } else {
            this.sendAndRecall(session, `已取消对 ${targetName} 的投票`)
          }
          this.cleanupVote(voteKey)
        }, 3600000)
        let pollInterval: NodeJS.Timeout | undefined
        if (this.voteReaction) {
          await this.setMsgEmoji(session, messageId, 76)
          await this.setMsgEmoji(session, messageId, 77)
          pollInterval = setInterval(async () => {
            const vData = this.activeVotes.get(voteKey)
            if (!vData) return
            const approvers = await this.fetchEmojiLikes(session, messageId, 76)
            const rejecters = await this.fetchEmojiLikes(session, messageId, 77)
            vData.approvers = new Set(approvers)
            vData.rejecters = new Set(rejecters)
            await this.executeVote(voteKey, session)
          }, 300000)
        }
        this.activeVotes.set(voteKey, { guildId, guildName: guildInfo.name, targetId, targetName, messageId, timer, pollInterval, duration: kick ? 0 : duration, approvers: new Set(), rejecters: new Set(), isRevoke: !!isRevoke })
      })
    root.subcommand('revoke', '撤回消息')
      .usage('回复指定消息来撤回对应内容。')
      .action(async ({ session }: { session: Session }) => {
        const quote = session.quote
        if (!quote?.id || !quote?.user?.id) return this.sendAndRecall(session, '请回复需要撤回的消息')
        if (quote.user.id === session.selfId) return session.bot.deleteMessage(session.guildId!, quote.id).catch(() => {})
        if (!this.checkPermission(session, this.allowedListen, true) || !this.revokeUsers.has(`${session.userId}-${session.guildId}-${quote.user.id}`)) return
        const logs = this.revokeLogs.get(`${session.guildId}-${quote.user.id}`)
        if (logs) logs.push({ type: 'node', data: { name: quote.user.name, uin: quote.user.id, content: quote.content } })
        try { await (session as any).onebot._request('delete_msg', { message_id: quote.id }) } catch (error) {}
      })
  }

  private async executeVote(voteKey: string, session: Session) {
    const voteData = this.activeVotes.get(voteKey)
    if (!voteData) return
    const [appReq, rejReq] = this.ratio.split(':').map(Number)
    if (voteData.approvers.size < appReq && voteData.rejecters.size < rejReq) return
    this.cleanupVote(voteKey)
    if (voteData.approvers.size < appReq) {
      if (this.voteReaction) {
        await this.setMsgEmoji(session, voteData.messageId, 123)
      } else {
        this.sendAndRecall(session, `已放弃对 ${voteData.targetName} 的操作`)
      }
      return
    }
    const targetKey = `${voteData.guildId}-${voteData.targetId}`
    this.revokeLogs.set(targetKey, [])
    voteData.approvers.forEach((id) => this.revokeUsers.add(`${id}-${targetKey}`))
    setTimeout(() => {
      const logs = this.revokeLogs.get(targetKey)
      if (logs?.length) this.mgmtGroups.forEach((gid) => (session.bot as any).internal.sendGroupForwardMsg(gid, logs).catch(() => {}))
      voteData.approvers.forEach((id) => this.revokeUsers.delete(`${id}-${targetKey}`))
      this.revokeLogs.delete(targetKey)
    }, 300000)
    if (this.voteReaction) {
      await this.setMsgEmoji(session, voteData.messageId, 124)
    } else {
      session.bot.sendMessage(session.guildId!, `已对 ${voteData.targetName} 执行：${voteData.isRevoke ? '撤回权限' : (voteData.duration > 0 ? `禁言${voteData.duration}分钟` : '踢出群聊')}`)
    }
    if (!voteData.isRevoke) {
      const action = voteData.duration > 0 ? session.bot.muteGuildMember(voteData.guildId, voteData.targetId, voteData.duration * 60000) : session.bot.kickGuildMember(voteData.guildId, voteData.targetId)
      action.catch(async (error) => {
        if (this.voteReaction) {
          await this.setMsgEmoji(session, voteData.messageId, 146)
        } else {
          this.sendAndRecall(session, `对 ${voteData.targetName} 的操作失败: ${error.message}`)
        }
      })
    }
  }

  async receiveMessage(session: Session) {
    if (this.voteReaction || !session.quote?.id || !session.guildId || !this.mgmtGroups.includes(session.guildId)) return
    const content = (session.content || '').toLowerCase()
    if (!content.includes('y') && !content.includes('n')) return
    const entry = [...this.activeVotes.entries()].find(([_, data]) => data.messageId === String(session.quote!.id))
    if (!entry) return
    const [voteKey, voteData] = entry
    const isApprove = content.includes('y')
    if (isApprove) {
      voteData.approvers.add(session.userId!)
      voteData.rejecters.delete(session.userId!)
    } else {
      voteData.rejecters.add(session.userId!)
      voteData.approvers.delete(session.userId!)
    }
    await this.executeVote(voteKey, session)
  }

  clearResource() {
    this.activeVotes.forEach((_, key) => this.cleanupVote(key))
    this.revokeUsers.clear()
    this.revokeLogs.clear()
  }
}
