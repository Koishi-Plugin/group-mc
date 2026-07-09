import { Context, Schema, Session } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'
import { FileRecord } from './FileRecord'
import { Keyword } from './Keyword'
import { AutoMute } from './AutoMute'
import { VoteRule } from './VoteRule'

export const name = 'group-mc'
export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`
const USER_GROUPS = '633640264, 203232161, 201034984, 533529045, 744304553, 282845310, 482624681, 991620626, 657677715, 775084843, 1028074835, 1070029541'
const ERROR_GROUPS = '666546887, 978054335, 958853931'
const ADMIN_LIST = [
  '3574467868', // 面包
  '603484945',  // 辞庐
  '3857585950', // 辞庐 Bot
  '3553841566', // 阿戈美拉汀
  '3239765997', // 阿戈美拉汀 Bot
  '3377239292', // BurningTNT
  '1876361913', // A Cup of Cat
  '1124171308', // Viola_Siemens
  '2563775587', // Null
  '460110340',  // 炸鸭
  '1913532130', // 墨渊
  '1094728939', // 鸽秋
  '1557468184', // 北葵
  '3260203441', // 陈梦泽
  '3096499384', // 祷祷祷祷
  '2531493755', // Shulker
  '1594258388', // biantwin
  '3515960079', // Minecraft
  '2247380761' // Konstantyn
]

export interface Config {
  recordFile: boolean
  voteBan: boolean
  keywordRule: false | string
  timeMute: false | string
  timeRange: string
  enableOcr: boolean
  replyMode: 'none' | 'quote' | 'at'
  recordTime: number
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    recordFile: Schema.boolean().default(false).description('报告记录'),
    voteBan: Schema.boolean().default(false).description('投票群管'),
    keywordRule: Schema.union([Schema.const(false).description('禁用'), Schema.string().description('启用')]).description('正则操作').default(USER_GROUPS),
    timeMute: Schema.union([Schema.const(false).description('禁用'), Schema.string().description('启用')]).description('自动宵禁').default(ERROR_GROUPS),
  }).description('功能配置'),
  Schema.object({
    timeRange: Schema.string().default('23-7').description('宵禁时间'),
    enableOcr: Schema.boolean().default(false).description('图片识别'),
    replyMode: Schema.union([Schema.const('none').description('无'), Schema.const('quote').description('回复'), Schema.const('at').description('艾特')]).default('quote').description('回复方式'),
    recordTime: Schema.number().default(2).description('记录时间'),
  }).description('参数配置'),
])

export function apply(context: Context, config: Config) {
  const parse = (str: string) => str.split(/[,，]/).map(v => v.trim()).filter(Boolean)
  const validate = (session: Session, allowedGroups: string[], requireAdmin = false): boolean => {
    if (!session.guildId || !session.userId || !allowedGroups.includes(session.guildId)) return false
    return !(requireAdmin && !ADMIN_LIST.includes(session.userId))
  }

  const keyword = typeof config.keywordRule === 'string' ? new Keyword(context, parse(config.keywordRule), validate, config.replyMode, config.enableOcr) : null
  const mute = typeof config.timeMute === 'string' ? new AutoMute(context, parse(config.timeMute), ADMIN_LIST, config.timeRange) : null
  const record = config.recordFile ? new FileRecord(context, validate, config.recordTime) : null
  const vote = config.voteBan ? new VoteRule(context, validate) : null

  const root = context.command('mcgroup', 'MC 群组管理')
  keyword?.registerCommands(root)
  vote?.registerCommands(root)

  context.on('message', async (session) => {
    if (!session.guildId || !Array.from(new Set([...parse(USER_GROUPS), ...parse(ERROR_GROUPS), '978519342'])).includes(session.guildId)) return
    await vote?.checkMessage(session)
    await mute?.recordActivity(session)
    await record?.receiveMessage(session)
    await keyword?.receiveMessage(session)
  })

  context.on('dispose', () => {
    vote?.clearResource()
    mute?.clearResource()
  })
}
