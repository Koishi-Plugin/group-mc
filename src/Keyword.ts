import { join, parse } from 'path'
import { promises as fs } from 'fs'
import { Context, h, Session } from 'koishi'

interface KeywordItem {
  action: 'reply' | 'forward'
  keyword: string
  content?: string
  pattern?: string
}

export class Keyword {
  private itemList: KeywordItem[] = []
  private targetFile: string
  private quoteMessage: boolean = true
  private mentionUser: boolean = false
  private forwardTarget: string = ''
  private adminList: { userId: string; nickname?: string }[] = []

  constructor(private context: Context) {
    const folderPath = join(context.baseDir, 'data', 'group-mc')
    this.targetFile = join(folderPath, 'keyword.json')
    this.loadData()
  }

  private async loadData(): Promise<void> {
    try {
      const fileData = await fs.readFile(this.targetFile, 'utf-8')
      this.itemList = JSON.parse(fileData) as KeywordItem[]
    } catch (error: any) {
      if (error.code !== 'ENOENT') this.context.logger.error('加载关键词失败:', error)
      this.itemList = []
    }
  }

  private async saveData(): Promise<void> {
    const { targetFile, itemList } = this
    await fs.mkdir(parse(targetFile).dir, { recursive: true })
    await fs.writeFile(targetFile, JSON.stringify(itemList, null, 2))
  }

  private async convertImage(rawText: string): Promise<string> {
    const elementArray = await Promise.all(
      h.parse(rawText).map(async element => {
        if (element.type !== 'img' || !element.attrs.src?.startsWith('http')) return element
        const fetchUrl = element.attrs.src
        const response = await this.context.http.get<ArrayBuffer>(fetchUrl, { responseType: 'arraybuffer' })
        const fetchBuffer = Buffer.from(response)
        const extension = parse(new URL(fetchUrl).pathname).ext.toLowerCase()
        const mimeType = extension === '.png' ? 'image/png' : extension === '.gif' ? 'image/gif' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
        element.attrs.src = `data:${mimeType};base64,${fetchBuffer.toString('base64')}`
        return element
      })
    )
    return h.normalize(elementArray).join('')
  }

  private createReply(session: Session, messageText: string, targetId?: string): h[] {
    const { quoteMessage, mentionUser } = this
    const replyElements: h[] = []
    if (quoteMessage && session.messageId) replyElements.push(h('quote', { id: session.messageId }))
    if (targetId) {
      replyElements.push(h('at', { id: targetId }), h('text', { content: ' ' }))
    } else if (mentionUser) {
      replyElements.push(h('at', { id: session.userId }), h('text', { content: ' ' }))
    }
    replyElements.push(h.text(messageText))
    return replyElements
  }

  registerCommands(rootCommand: any): void {
    const { adminList } = this
    const keywordCommand = rootCommand.subcommand('keyword', '关键词管理')

    keywordCommand.subcommand('.add <action:string> <keyword:string> [content:text]', '添加关键词 (action为 reply/forward)')
      .action(async ({ session }: { session: Session }, action: string, keyword: string, content: string) => {
        if (!adminList.some(admin => admin.userId === session.userId)) return
        if (action !== 'reply' && action !== 'forward') return '操作类型必须为 reply 或 forward'
        if (!keyword) return '请提供关键词'
        if (action === 'reply' && !content) return '回复模式下请提供回复内容'
        return this.addItem(action, keyword, content)
      })

    keywordCommand.subcommand('.remove <action:string> <keyword:string>', '删除关键词')
      .action(({ session }: { session: Session }, action: string, keyword: string) => {
        if (!adminList.some(admin => admin.userId === session.userId)) return
        return this.removeItem(action, keyword)
      })

    keywordCommand.subcommand('.rename <action:string> <oldKeyword:string> <newKeyword:string>', '重命名关键词')
      .action(({ session }: { session: Session }, action: string, oldKeyword: string, newKeyword: string) => {
        if (!adminList.some(admin => admin.userId === session.userId)) return
        return this.renameItem(action, oldKeyword, newKeyword)
      })

    keywordCommand.subcommand('.list [action:string]', '查看关键词列表')
      .action(({ session }: { session: Session }, action: string) => {
        if (!adminList.some(admin => admin.userId === session.userId)) return
        return this.listItems(action)
      })

    keywordCommand.subcommand('.regex <action:string> <keyword:string> [pattern:text]', '配置正则匹配')
      .action(({ session }: { session: Session }, action: string, keyword: string, pattern: string) => {
        if (!adminList.some(admin => admin.userId === session.userId)) return
        return this.updateRegex(action, keyword, pattern)
      })

    keywordCommand.subcommand('.send <keyword:string> [target:string] [value:text]', '发送预设回复')
      .action(async ({ session }: { session: Session }, keyword: string, target: string, value: string) => {
        if (!adminList.some(admin => admin.userId === session.userId)) return
        if (!keyword) return '请提供预设关键词'
        // 修复：增加对 channelId 和 messageId 的非空检查
        if (session.channelId && session.messageId) {
          await session.bot.deleteMessage(session.channelId, session.messageId).catch(() => {})
        }
        return this.sendManual(session, keyword, target, value)
      })
  }

  async addItem(action: string, keyword: string, content?: string): Promise<string> {
    const { itemList } = this
    if (itemList.some(item => item.keyword === keyword && item.action === action)) return `类型 [${action}] 关键词「${keyword}」已存在`
    const finalContent = content ? await this.convertImage(content) : undefined
    itemList.push({ action: action as 'reply' | 'forward', keyword, content: finalContent })
    await this.saveData()
    return `成功添加 [${action}] 关键词「${keyword}」`
  }

  async removeItem(action: string, keyword: string): Promise<string> {
    const { itemList } = this
    const targetIndex = itemList.findIndex(item => item.keyword === keyword && item.action === action)
    if (targetIndex === -1) return `未找到 [${action}] 关键词「${keyword}」`
    itemList.splice(targetIndex, 1)
    await this.saveData()
    return `成功删除 [${action}] 关键词「${keyword}」`
  }

  async renameItem(action: string, oldKeyword: string, newKeyword: string): Promise<string> {
    const { itemList } = this
    if (oldKeyword === newKeyword) return '新旧关键词不能相同'
    const targetItem = itemList.find(item => item.keyword === oldKeyword && item.action === action)
    if (!targetItem) return `未找到 [${action}] 关键词「${oldKeyword}」`
    if (itemList.some(item => item.keyword === newKeyword && item.action === action)) return `[${action}] 关键词「${newKeyword}」已存在`
    targetItem.keyword = newKeyword
    await this.saveData()
    return `成功重命名 [${action}] 关键词「${oldKeyword}」为「${newKeyword}」`
  }

  listItems(action?: string): string {
    const { itemList } = this
    const filterList = action ? itemList.filter(item => item.action === action) : itemList
    if (!filterList.length) return `当前没有配置关键词`
    return `可用关键词列表：\n${filterList.map(item => `[${item.action}] ${item.keyword}`).join('\n')}`
  }

  async updateRegex(action: string, keyword: string, pattern?: string): Promise<string> {
    const { itemList } = this
    const targetItem = itemList.find(item => item.keyword === keyword && item.action === action)
    if (!targetItem) return `未找到 [${action}] 关键词「${keyword}」`
    if (pattern) {
      targetItem.pattern = pattern
      await this.saveData()
      return `成功为 [${action}] 关键词「${keyword}」设置正则`
    }
    delete targetItem.pattern
    await this.saveData()
    return `成功移除 [${action}] 关键词「${keyword}」的正则`
  }

  async sendManual(session: Session, keyword: string, target?: string, value?: string): Promise<string> {
    const { itemList } = this
    const targetItem = itemList.find(item => item.keyword === keyword && item.action === 'reply')
    if (!targetItem || !targetItem.content) return `未找到预设回复「${keyword}」`
    const finalReply = value ? targetItem.content.replace(/{placeholder}/g, value) : targetItem.content
    const targetId = target ? (h.select(h.parse(target), 'at')[0]?.attrs?.id ?? target.match(/@?(\d+)/)?.[1]) : undefined
    const replyElements = this.createReply(session, '', targetId)
    replyElements.pop()
    replyElements.push(...h.parse(finalReply), h('text', { content: '\n调用者：' }), h('at', { id: session.userId }))
    await session.send(replyElements)
    return ''
  }

  async receiveMessage(session: Session): Promise<void> {
    const { itemList, forwardTarget } = this
    if (!itemList.length) return
    const textContent = session.content
    if (!textContent) return

    let handledReply = false

    if (forwardTarget) {
      const forwardMatch = itemList.find(item => item.action === 'forward' && (item.pattern ? new RegExp(item.pattern, 'i').test(textContent) : textContent.includes(item.keyword)))
      if (forwardMatch) {
        const sourceInfo = `消息来源: ${session.userId} (群: ${session.guildId || session.channelId})`
        await session.bot.sendMessage(forwardTarget, [h('text', { content: `${sourceInfo}\n` }), ...(session.elements || [])])
      }
    }

    handledReply = await this.triggerReply(textContent, session)

    if (!handledReply) {
      const imageElement = session.elements?.find(element => element.type === 'img')
      if (imageElement && typeof session.bot.internal?.ocrImage === 'function') {
        const ocrResult = await session.bot.internal.ocrImage(imageElement.attrs.src)
        if (Array.isArray(ocrResult) && ocrResult.length > 0) {
          const ocrText = ocrResult.map((res: any) => res.text).filter((text: string) => text?.trim()).join('\n')
          if (ocrText) await this.triggerReply(ocrText, session)
        }
      }
    }
  }

  private async triggerReply(textInput: string, session: Session): Promise<boolean> {
    const { itemList } = this
    const targetItem = itemList.find(item => item.action === 'reply' && (item.pattern ? new RegExp(item.pattern, 'i').test(textInput) : textInput.includes(item.keyword)))
    if (!targetItem || !targetItem.content) return false
    const replyElements = this.createReply(session, '')
    replyElements.pop()
    replyElements.push(...h.parse(targetItem.content))
    await session.send(replyElements)
    return true
  }
}
