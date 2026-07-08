import { Context, Schema } from 'koishi'
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

export interface Config {
  recordFile?: boolean
  keywordRule?: boolean
  timeMute?: boolean
  voteBan?: boolean
}

export const Config: Schema<Config> = Schema.object({
  recordFile: Schema.boolean().default(false).description('报告记录'),
  keywordRule: Schema.boolean().default(false).description('正则操作'),
  timeMute: Schema.boolean().default(false).description('自动宵禁'),
  voteBan: Schema.boolean().default(false).description('投票群管'),
}).description('功能配置')

export function apply(context: Context, config: Config) {
  const keyword = config.keywordRule ? new Keyword(context) : null
  const record = config.recordFile ? new FileRecord(context) : null
  const mute = config.timeMute ? new AutoMute(context) : null
  const vote = config.voteBan ? new VoteRule(context) : null

  const root = context.command('mcgroup', 'MC 群组管理')
  keyword?.registerCommands(root)
  vote?.registerCommands(root)

  context.on('message', async (session) => {
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
