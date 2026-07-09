import { join, parse } from 'path'
import { promises as fs, existsSync, mkdirSync } from 'fs'
import { Context, h, Session } from 'koishi'

interface KeywordItem {
  forward: boolean
  keyword: string
  content?: string
  pattern?: string
}

export class Keyword {
  private itemList: KeywordItem[] = []
  private readonly dataFile: string
  private readonly assetDir: string

  constructor(private context: Context, private targetGroups: string[], private validate: (session: Session, groups: string[], admin?: boolean) => boolean, private replyMode: 'none' | 'quote' | 'at', private enableOcr: boolean) {
    const root = join(context.baseDir, 'data', 'group-mc')
    this.dataFile = join(root, 'keyword.json')
    this.assetDir = join(root, 'keyword')

    if (!existsSync(this.assetDir)) mkdirSync(this.assetDir, { recursive: true })
    if (existsSync(this.dataFile)) fs.readFile(this.dataFile, 'utf-8').then(d => this.itemList = JSON.parse(d)).catch(() => {})
  }

  private async processAssets(raw: string): Promise<string> {
    const elements = h.parse(raw)
    for (const el of elements) {
      if (el.type === 'img' && el.attrs.src?.startsWith('http')) {
        const buffer = await this.context.http.get<ArrayBuffer>(el.attrs.src, { responseType: 'arraybuffer' })
        const ext = parse(new URL(el.attrs.src).pathname).ext
        const filename = `${Date.now()}${ext}`
        await fs.writeFile(join(this.assetDir, filename), Buffer.from(buffer))
        el.attrs.src = `local://${filename}`
      }
    }
    return h.normalize(elements).join('')
  }

  private async resolveAssets(content: string): Promise<h[]> {
    return Promise.all(h.parse(content).map(async el => {
      if (el.type === 'img' && el.attrs.src?.startsWith('local://')) {
        const filename = el.attrs.src.replace('local://', '')
        const buffer = await fs.readFile(join(this.assetDir, filename))
        el.attrs.src = `data:image/${parse(filename).ext.slice(1)};base64,${buffer.toString('base64')}`
      }
      return el
    }))
  }

  registerCommands(root: any): void {
    root.subcommand('radd <keyword:string> <content:text>', '添加回复关键词')
      .action(async ({ session }: { session: Session }, keyword: string, content: string) => {
        if (!this.validate(session, this.targetGroups, true) || !keyword || !content) return
        try {
          const processedContent = await this.processAssets(content)
          const idx = this.itemList.findIndex(i => i.keyword === keyword)
          const newItem = { keyword, content: processedContent, forward: false }
          if (idx !== -1) this.itemList[idx] = newItem
          else this.itemList.push(newItem)
          await fs.writeFile(this.dataFile, JSON.stringify(this.itemList, null, 2))
          return `已保存：${keyword}`
        } catch (e) {
          return `保存失败`
        }
      })

    root.subcommand('fadd <keyword:string>', '添加转发关键词')
      .action(async ({ session }: { session: Session }, keyword: string) => {
        if (!this.validate(session, this.targetGroups, true) || !keyword) return
        const idx = this.itemList.findIndex(i => i.keyword === keyword)
        const newItem = { keyword, forward: true }
        if (idx !== -1) this.itemList[idx] = newItem
        else this.itemList.push(newItem)
        await fs.writeFile(this.dataFile, JSON.stringify(this.itemList, null, 2))
        return `已保存：${keyword}`
      })

    root.subcommand('del <keyword:string>', '删除关键词')
      .action(async ({ session }: { session: Session }, keyword: string) => {
        if (!this.validate(session, this.targetGroups, true) || !keyword) return
        const idx = this.itemList.findIndex(i => i.keyword === keyword)
        if (idx === -1) return '未找到关键词'
        this.itemList.splice(idx, 1)
        await fs.writeFile(this.dataFile, JSON.stringify(this.itemList, null, 2))
        return `已删除：${keyword}`
      })

    root.subcommand('regex <keyword:string> [pattern:text]', '配置正则')
      .action(async ({ session }: { session: Session }, keyword: string, pattern: string) => {
        if (!this.validate(session, this.targetGroups, true) || !keyword) return
        const item = this.itemList.find(i => i.keyword === keyword)
        if (!item) return '未找到关键词'
        item.pattern = pattern || undefined
        await fs.writeFile(this.dataFile, JSON.stringify(this.itemList, null, 2))
        return `已更新：${pattern}`
      })

    root.subcommand('view [keyword:string] [value:text]', '查看关键词')
      .action(async ({ session }: { session: Session }, keyword: string, value: string) => {
        if (!this.validate(session, this.targetGroups, true)) return
        if (!keyword) return `关键词列表：\n${this.itemList.map(i => `${i.forward ? '[F]' : '[R]'} ${i.keyword}`).join('\n')}`
        const item = this.itemList.find(i => i.keyword === keyword)
        if (!item || item.forward || !item.content) return '未找到关键词'
        if (session.channelId && session.messageId) session.bot.deleteMessage(session.channelId, session.messageId).catch(() => {})
        const elements = await this.resolveAssets(value ? item.content.replace(/{placeholder}/g, value) : item.content)
        await session.send([...elements, '\n调用者：', h('at', { id: session.userId })])
      })
  }

  async receiveMessage(session: Session): Promise<void> {
    if (!this.validate(session, this.targetGroups) || !session.content) return
    const findMatch = (text: string) => this.itemList.find(i => i.pattern ? new RegExp(i.pattern, 'i').test(text) : text.includes(i.keyword))
    let target = findMatch(session.content)
    if (!target && this.enableOcr) {
      const img = session.elements?.find(e => e.type === 'img')
      if (img && typeof session.bot.internal.ocrImage === 'function') {
        const ocr = await session.bot.internal.ocrImage(img.attrs.src).catch(() => [])
        target = findMatch(ocr.map((r: any) => r.text).join(' '))
      }
    }
    if (!target) return
    if (target.forward) await session.bot.sendMessage('978519342', [`来源: ${session.userId}(${session.guildId})\n`, ...(session.elements || [])])
    if (target.content) {
      const resp: any[] = []
      if (this.replyMode === 'quote' && session.messageId) resp.push(h('quote', { id: session.messageId }))
      if (this.replyMode === 'at' && session.userId) resp.push(h('at', { id: session.userId }), ' ')
      resp.push(...await this.resolveAssets(target.content))
      await session.send(resp)
    }
  }
}
