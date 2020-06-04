const util = require('util')
const fs = require('fs')
const path = require('path')
const slug = require('slug')
const JSZip = require('jszip')
const dialogflow = require('@google-cloud/dialogflow')
const _ = require('lodash')
const botium = require('botium-core')
const { convertToDialogflowUtterance, jsonBuffer } = require('./helpers')
const debug = require('debug')('botium-connector-dialogflow-intents')

const importIntents = async ({ agentInfo, zipEntries, unzip }, argv, { statusCallback }) => {
  const status = (log, obj) => {
    debug(log, obj)
    if (statusCallback) statusCallback(log, obj)
  }

  const intentEntries = zipEntries.filter((zipEntry) => zipEntry.name.startsWith('intent') && !zipEntry.name.match('usersays'))

  const convos = []
  const utterances = []

  for (const zipEntry of intentEntries) {
    const intent = JSON.parse(await unzip.file(zipEntry.name).async('string'))
    if (intent.parentId) continue

    const utterancesEntryName = zipEntry.name.replace('.json', '') + '_usersays_' + agentInfo.language + '.json'
    debug(`Found root intent "${intent.name}", checking for utterances in ${utterancesEntryName}`)
    if (!zipEntries.find((zipEntry) => zipEntry.name === utterancesEntryName)) {
      status(`Utterances files not found for "${intent.name}", ignoring intent`)
      continue
    }
    const utterancesEntry = JSON.parse(await unzip.file(utterancesEntryName).async('string'))
    const inputUtterances = utterancesEntry.map((utterance) => utterance.data.reduce((accumulator, currentValue) => accumulator + '' + currentValue.text, ''))

    if (argv.buildconvos) {
      const utterancesRef = slug(intent.name)
      utterances.push({
        name: utterancesRef,
        utterances: inputUtterances
      })

      const convo = {
        header: {
          name: intent.name
        },
        conversation: [
          {
            sender: 'me',
            messageText: utterancesRef
          },
          {
            sender: 'bot',
            asserters: [
              {
                name: 'INTENT',
                args: [intent.name]
              }
            ]
          }
        ]
      }
      if (intent.contexts && intent.contexts.length > 0) {
        convo.conversation[0].logicHooks = intent.contexts.map(context => ({
          name: 'UPDATE_CUSTOM',
          args: [
            'SET_DIALOGFLOW_CONTEXT',
            context,
            1
          ]
        }))
      }

      convos.push(convo)
    } else {
      if (intent.contexts && intent.contexts.length > 0) {
        status(`Found intent requiring context ("${intent.name}": ${intent.contexts.join(',')}), ignoring intent`)
      } else {
        utterances.push({
          name: intent.name,
          utterances: inputUtterances
        })
      }
    }
  }
  return { convos, utterances }
}

const importConversations = async ({ agentInfo, zipEntries, unzip }, argv, { statusCallback }) => {
  const status = (log, obj) => {
    debug(log, obj)
    if (statusCallback) statusCallback(log, obj)
  }

  const intentEntries = zipEntries.filter((zipEntry) => zipEntry.name.startsWith('intent') && !zipEntry.name.match('usersays'))

  const convos = []
  const utterances = []

  const intentsById = {}
  for (const zipEntry of intentEntries) {
    const intent = JSON.parse(await unzip.file(zipEntry.name).async('string'))

    const utterancesEntry = zipEntry.name.replace('.json', '') + '_usersays_' + agentInfo.language + '.json'
    debug(`Found intent ${intent.name}, checking for utterances in ${utterancesEntry}`)
    if (!zipEntries.find((zipEntry) => zipEntry.name === utterancesEntry)) {
      status(`Utterances files not found for ${intent.name}, ignoring intent`)
      continue
    }
    intentsById[intent.id] = intent

    const utterances = JSON.parse(await unzip.file(utterancesEntry).async('string'))
    intent.inputUtterances = utterances.map((utterance) => utterance.data.reduce((accumulator, currentValue) => accumulator + '' + currentValue.text, ''))
    debug(`Utterances file for ${intent.name}: ${intent.inputUtterances}`)

    intent.outputUtterances = []
    if (intent.responses) {
      intent.responses.forEach((response) => {
        if (response.messages) {
          const speechOutputs = response.messages
            .filter((message) => message.type === '0' && message.lang === agentInfo.language && message.speech)
            .reduce((acc, message) => {
              if (_.isArray(message.speech)) acc = acc.concat(message.speech)
              else acc.push(message.speech)
              return acc
            }, [])
          if (speechOutputs) {
            intent.outputUtterances.push(speechOutputs)
          } else {
            intent.outputUtterances.push([])
          }
        } else {
          intent.outputUtterances.push([])
        }
      })
    }
  }
  Object.keys(intentsById).forEach((intentId) => {
    const intent = intentsById[intentId]
    debug(intent.name + '/' + intent.parentId)
    if (intent.parentId) {
      const parent = intentsById[intent.parentId]
      if (parent) {
        if (!parent.children) parent.children = []
        parent.children.push(intent)
      } else {
        debug(`Parent intent with id ${intent.parentId} not found for ${intent.name}, ignoring intent`)
      }
    }
  })
  Object.keys(intentsById).forEach((intentId) => {
    const intent = intentsById[intentId]
    if (intent.parentId) {
      delete intentsById[intentId]
    }
  })

  const follow = (intent, currentStack = []) => {
    const cp = currentStack.slice(0)

    const utterancesRef = slug(intent.name + '_input')
    cp.push({ sender: 'me', messageText: utterancesRef, intent: intent.name })

    utterances.push({
      name: utterancesRef,
      utterances: intent.inputUtterances
    })

    if (intent.outputUtterances && intent.outputUtterances.length > 0) {
      for (let stepIndex = 0; stepIndex < intent.outputUtterances.length; stepIndex++) {
        const convoStep = {
          sender: 'bot',
          asserters: [
            {
              name: 'INTENT',
              args: [intent.name]
            }
          ]
        }
        if (intent.outputUtterances[stepIndex] && intent.outputUtterances[stepIndex].length > 0) {
          const utterancesRef = slug(intent.name + '_output_' + stepIndex)
          utterances.push({
            name: utterancesRef,
            utterances: intent.outputUtterances[stepIndex]
          })
          convoStep.messageText = utterancesRef
        }
        cp.push(convoStep)
      }
    } else {
      cp.push({ sender: 'bot', messageText: '!INCOMPREHENSION' })
    }

    if (intent.children) {
      intent.children.forEach((child) => {
        follow(child, cp)
      })
    } else {
      const convo = {
        header: {
          name: cp.filter((m) => m.sender === 'me').map((m) => m.intent).join(' - ')
        },
        conversation: cp
      }
      debug(convo)
      convos.push(convo)
    }
  }
  Object.keys(intentsById).forEach((intentId) => follow(intentsById[intentId], []))

  return { convos, utterances }
}

const loadAgentZip = async (filenameOrRawData) => {
  const result = {
    zipEntries: []
  }
  if (_.isBuffer(filenameOrRawData)) {
    result.unzip = await JSZip.loadAsync(filenameOrRawData)
  } else {
    const buf = fs.readFileSync(filenameOrRawData)
    result.unzip = await JSZip.loadAsync(buf)
  }
  result.unzip.forEach((relativePath, zipEntry) => {
    result.zipEntries.push(zipEntry)
    debug(`Dialogflow agent got entry: ${zipEntry.name}`)
  })
  result.agentInfo = JSON.parse(await result.unzip.file('agent.json').async('string'))
  debug(`Dialogflow agent info: ${util.inspect(result.agentInfo)}`)
  return result
}

const importDialogflow = async (argv, status, importFunction) => {
  const caps = argv.caps || {}
  if (argv.agentzip) {
    caps[botium.Capabilities.CONTAINERMODE] = () => ({ UserSays: () => {} })
  } else {
    caps[botium.Capabilities.CONTAINERMODE] = path.resolve(__dirname, '..', 'index.js')
  }
  const botiumContext = {
    driver: new botium.BotDriver(caps),
    compiler: null,
    container: null,
    unzip: null,
    zipEntries: null,
    agentInfo: null
  }

  botiumContext.container = await botiumContext.driver.Build()
  botiumContext.compiler = await botiumContext.driver.BuildCompiler()

  if (!argv.agentzip) {
    try {
      const agentsClient = new dialogflow.AgentsClient(botiumContext.container.pluginInstance.sessionOpts)
      const projectPath = agentsClient.projectPath(botiumContext.container.caps.DIALOGFLOW_PROJECT_ID)

      const allResponses = await agentsClient.exportAgent({ parent: projectPath })
      const responses = await allResponses[0].promise()
      try {
        const buf = Buffer.from(responses[0].agentContent, 'base64')
        Object.assign(botiumContext, await loadAgentZip(buf))
      } catch (err) {
        throw new Error(`Dialogflow agent unpack failed: ${err && err.message}`)
      }
    } catch (err) {
      throw new Error(`Dialogflow agent connection failed: ${err && err.message}`)
    }
  } else {
    try {
      Object.assign(botiumContext, await loadAgentZip(argv.agentzip))
    } catch (err) {
      throw new Error(`Dialogflow agent unpack failed: ${err && err.message}`)
    }
  }
  const { convos, utterances } = await importFunction(botiumContext, argv, status)

  try {
    await botiumContext.container.Clean()
  } catch (err) {
    debug(`Error container cleanup: ${err && err.message}`)
  }
  return { convos, utterances }
}

const importHandler = async (argv, status) => {
  debug(`command options: ${util.inspect(argv)}`)

  let result = null
  if (argv.buildmultistepconvos) {
    result = await importDialogflow(argv, status, importConversations)
  } else {
    result = await importDialogflow(argv, status, importIntents)
  }
  return {
    convos: result.convos,
    utterances: result.utterances
  }
}

const exportHandler = async ({ caps, agentzip, output, ...rest }, { utterances, convos }, { statusCallback }) => {
  caps = caps || {}
  if (agentzip) {
    caps[botium.Capabilities.CONTAINERMODE] = () => ({ UserSays: () => {} })
  } else {
    caps[botium.Capabilities.CONTAINERMODE] = path.resolve(__dirname, '..', 'index.js')
  }
  const driver = new botium.BotDriver(caps)
  const container = await driver.Build()

  const status = (log, obj) => {
    debug(log, obj)
    if (statusCallback) statusCallback(log, obj)
  }

  try {
    let agent = null

    if (!agentzip) {
      try {
        const agentsClient = new dialogflow.AgentsClient(container.pluginInstance.sessionOpts)
        const projectPath = agentsClient.projectPath(container.caps.DIALOGFLOW_PROJECT_ID)

        const allResponses = await agentsClient.exportAgent({ parent: projectPath })
        const responses = await allResponses[0].promise()
        try {
          const buf = Buffer.from(responses[0].agentContent, 'base64')
          agent = await loadAgentZip(buf)
        } catch (err) {
          throw new Error(`Dialogflow agent unpack failed: ${err && err.message}`)
        }
      } catch (err) {
        throw new Error(`Dialogflow agent connection failed: ${err && err.message}`)
      }
    } else {
      try {
        agent = await loadAgentZip(agentzip)
      } catch (err) {
        throw new Error(`Dialogflow agent unpack failed: ${err && err.message}`)
      }
    }

    for (const utt of utterances) {
      const utterancesEntryName = `intents/${utt.name}_usersays_${agent.agentInfo.language}.json`
      const utterancesEntry = agent.zipEntries.find((zipEntry) => zipEntry.name === utterancesEntryName)
      if (!utterancesEntry) {
        status(`User examples files not found for "${utt.name}", ignoring intent`)
        continue
      }
      const utterancesEntryContent = JSON.parse(await agent.unzip.file(utterancesEntryName).async('string'))

      const agentExamples = utterancesEntryContent.map((utterance) => utterance.data.reduce((accumulator, currentValue) => accumulator + '' + currentValue.text, ''))
      const newExamples = utt.utterances.filter(u => !agentExamples.includes(u))
      if (newExamples.length === 0) {
        status(`No new user examples files found for "${utt.name}".`)
      } else {
        status(`${newExamples.length} new user examples found for "${utt.name}", adding to agent`)

        const newData = convertToDialogflowUtterance(newExamples, agent.agentInfo.language)
        agent.unzip.file(utterancesEntryName, jsonBuffer(utterancesEntryContent.concat(newData)))
      }
    }
    const agentZipBuffer = await agent.unzip.generateAsync({ type: 'nodebuffer' })
    if (output) {
      fs.writeFileSync(output, agentZipBuffer)
    } else {
      const agentsClient = new dialogflow.AgentsClient(container.pluginInstance.sessionOpts)
      const projectPath = agentsClient.projectPath(container.caps.DIALOGFLOW_PROJECT_ID)
      const agentResponses = await agentsClient.getAgent({ parent: projectPath })
      const newAgentInfo = agentResponses[0]
      const restoreResponses = await agentsClient.restoreAgent({ parent: newAgentInfo.parent, agentContent: agentZipBuffer })
      await restoreResponses[0].promise()
      status(`Uploaded Dialogflow Agent to ${projectPath}`)
    }
  } finally {
    if (container) {
      try {
        await container.Clean()
      } catch (err) {
        debug(`Error container cleanup: ${err && err.message}`)
      }
    }
  }
  return { }
}

module.exports = {
  importHandler: ({ caps, buildconvos, buildmultistepconvos, agentzip, ...rest } = {}, { statusCallback } = {}) => importHandler({ caps, buildconvos, buildmultistepconvos, agentzip, ...rest }, { statusCallback }),
  importArgs: {
    caps: {
      describe: 'Capabilities',
      type: 'json',
      skipCli: true
    },
    buildconvos: {
      describe: 'Build convo files with intent asserters',
      type: 'boolean',
      default: false
    },
    buildmultistepconvos: {
      describe: 'Reverse-engineer Dialogflow agent and build multi-step convo files',
      type: 'boolean',
      default: false
    },
    agentzip: {
      describe: 'Path to the exported Dialogflow agent zip file. If not given, it will be downloaded (with connection settings from botium.json).',
      type: 'string'
    }
  },
  exportHandler: ({ caps, agentzip, output, ...rest } = {}, { convos, utterances } = {}, { statusCallback } = {}) => exportHandler({ caps, agentzip, output, ...rest }, { convos, utterances }, { statusCallback }),
  exportArgs: {
    caps: {
      describe: 'Capabilities',
      type: 'json',
      skipCli: true
    },
    agentzip: {
      describe: 'Path to the exported Dialogflow agent zip file. If not given, it will be downloaded (with connection settings from botium.json).',
      type: 'string'
    },
    output: {
      describe: 'Path to the changed Dialogflow agent zip file.',
      type: 'string'
    }
  }
}
