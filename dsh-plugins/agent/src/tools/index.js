import { queryTools } from './query.js'
import { knowledgeTools } from './knowledge.js'
import { treeTools } from './tree.js'
import { fastTools } from './fast.js'
import { factTools } from './facts.js'
import { reflectTools } from './reflect.js'
import { curateTools } from './curate.js'

/**
 * 给大模型的全部工具（集成方案 §5.1，P1 子集）。没有任何按键 / 点击工具（I2）。
 * 返回 defineTool 的选项对象；index.js 包上 defineTool 再注册。
 */
export function createTools(services) {
  return [...queryTools(services), ...knowledgeTools(services), ...treeTools(services), ...reflectTools(services), ...curateTools(services), ...(services.fastBridge ? fastTools(services) : []), ...(services.facts ? factTools(services) : [])]
}

export { queryTools, knowledgeTools, treeTools, reflectTools, curateTools, fastTools, factTools }
