import color from '@heroku-cli/color'
import {get, RequestOptions} from 'https'

import cli from 'cli-ux'

import {Command} from '@heroku-cli/command'

import * as Heroku from '@heroku-cli/schema'
import * as http from 'http'
import * as io from 'socket.io-client'

const ansiEscapes = require('ansi-escapes')

const SIMI_URL = 'https://simi.heroku.com'

function logStream(url: RequestOptions | string, fn: (res: http.IncomingMessage) => void) {
  return get(url, fn)
}

function stream(url: string) {
  return new Promise((resolve, reject) => {
    const request = logStream(url, output => {
      output.on('data', data => {
        if (data.toString() === Buffer.from('').toString()) {
          request.abort()
          resolve()
        }
      })

      output.on('end', () => resolve())
      output.on('error', e => reject(e))
      output.pipe(process.stdout)
    })
  })
}

function statusIcon({status}: Heroku.TestRun | Heroku.TestNode) {
  if (!status) { return color.yellow('-') }

  switch (status) {
  case 'pending':
  case 'creating':
  case 'building':
  case 'running':
  case 'debugging':
    return color.yellow('-')
  case 'errored':
    return color.red('!')
  case 'failed':
    return color.red('✗')
  case 'succeeded':
    return color.green('✓')
  case 'cancelled':
    return color.yellow('!')
  default:
    return color.yellow('?')

  }
}

const BUILDING = 'building'
const RUNNING = 'running'
const ERRORED = 'errored'
const FAILED = 'failed'
const SUCCEEDED = 'succeeded'
const CANCELLED = 'cancelled'

const TERMINAL_STATES = [SUCCEEDED, FAILED, ERRORED, CANCELLED]
const RUNNING_STATES = [RUNNING].concat(TERMINAL_STATES)
const BUILDING_STATES = [BUILDING, RUNNING].concat(TERMINAL_STATES)

function printLine(testRun: Heroku.TestRun) {
  return `${statusIcon(testRun)} #${testRun.number} ${testRun.commit_branch}:${testRun.commit_sha!.slice(0, 7)} ${testRun.status}`
}

function printLineTestNode(testNode: Heroku.TestNode) {
  return `${statusIcon(testNode)} #${testNode.index} ${testNode.status}`
}

function processExitCode(command: Command, testNode: Heroku.TestNode) {
  if (testNode.exit_code && testNode.exit_code !== 0) {
    command.exit(testNode.exit_code)
  }
}

function handleTestRunEvent(newTestRun: Heroku.TestRun, testRuns: Heroku.TestRun[]) {
  const previousTestRun = testRuns.find(({id}) => id === newTestRun.id)

  if (previousTestRun) {
    const previousTestRunIndex = testRuns.indexOf(previousTestRun)
    testRuns.splice(previousTestRunIndex, 1)
  }

  testRuns.push(newTestRun)
  return testRuns
}

function sort(testRuns: Heroku.TestRun[]) {
  return testRuns.sort((a: Heroku.TestRun, b: Heroku.TestRun) => a.number! < b.number! ? 1 : -1)
}

function draw(testRuns: Heroku.TestRun[], watchOption = false, jsonOption = false, count = 15) {
  const latestTestRuns = sort(testRuns).slice(0, count)

  if (jsonOption) {
    cli.styledJSON(latestTestRuns)
    return
  }

  if (watchOption) {
    process.stdout.write(ansiEscapes.eraseDown)
  }

  let data: any = []

  latestTestRuns.forEach(testRun => {
    data.push(
      {
        iconStatus: `${statusIcon(testRun)}`,
        number: testRun.number,
        branch: testRun.commit_branch,
        sha: testRun.commit_sha!.slice(0, 7),
        status: testRun.status
      }
    )
  })

  cli.table(data, {
    printHeader: undefined,
    columns: [
      {key: 'iconStatus', width: 1, label: ''}, // label '' is to make sure that widh is 1 character
      {key: 'number', label: ''},
      {key: 'branch'},
      {key: 'sha'},
      {key: 'status'}
    ]
  })

  if (watchOption) {
    process.stdout.write(ansiEscapes.cursorUp(latestTestRuns.length))
  }
}

export async function renderList(command: Command, testRuns: Heroku.TestRun[], pipeline: Heroku.Pipeline, watchOption: boolean, jsonOption: boolean) {
  const watchable = (watchOption && !jsonOption ? true : false)

  if (!jsonOption) {
    const header = `${watchOption ? 'Watching' : 'Showing'} latest test runs for the ${pipeline.name} pipeline`
    cli.styledHeader(header)
  }

  if (watchable) {
    process.stdout.write(ansiEscapes.cursorHide)
  }

  draw(testRuns, watchOption, jsonOption)

  if (!watchable) { return }

  let socket = io.connect(SIMI_URL, {transports: ['websocket']})

  socket.on('connect', function () {
    socket.emit('joinRoom', {room: `pipelines/${pipeline.id}/test-runs`, token: command.heroku.auth})
  })

  socket.on('disconnect', function () {
    process.stdout.write(ansiEscapes.cursorShow)
  })

  socket.on('create', ({resource, data}: any) => {
    if (resource === 'test-run') {
      testRuns = handleTestRunEvent(data, testRuns)
      draw(testRuns, watchOption)
    }
  })

  socket.on('update', ({resource, data}: any) => {
    if (resource === 'test-run') {
      testRuns = handleTestRunEvent(data, testRuns)
      draw(testRuns, watchOption)
    }
  })
}

async function renderNodeOutput(command: Command, testRun: Heroku.TestRun, testNode: Heroku.TestNode) {
  if (!testNode) {
    command.error(`Test run ${testRun.number} was ${testRun.status}. No Heroku CI runs found for this pipeline.`)
  }

  await stream(testNode.setup_stream_url!)
  await stream(testNode.output_stream_url!)

  command.log()
  command.log(printLine(testRun))
}

async function waitForStates(states: string[], testRun: Heroku.TestRun, command: Command) {
  let newTestRun = testRun

  while (!states.includes(newTestRun.status!.toString())) {
    let {body: bodyTestRun} = await command.heroku.get<Heroku.TestRun>(`/pipelines/${testRun.pipeline!.id}/test-runs/${testRun.number}`)
    newTestRun = bodyTestRun
  }
  return newTestRun
}

async function display(pipeline: Heroku.Pipeline, number: number, command: Command) {
  let {body: testRun} = await command.heroku.get<Heroku.TestRun | undefined>(`/pipelines/${pipeline.id}/test-runs/${number}`)
  if (testRun) {
    cli.action.start('Waiting for build to start')
    testRun = await waitForStates(BUILDING_STATES, testRun, command)
    cli.action.stop()

    let {body: testNodes} = await command.heroku.get<Heroku.TestNode[]>(`/test-runs/${testRun.id}/test-nodes`)
    let firstTestNode = testNodes[0]

    if (firstTestNode) { await stream(firstTestNode.setup_stream_url!) }

    if (testRun) { testRun = await waitForStates(RUNNING_STATES, testRun, command) }
    if (firstTestNode) { await stream(firstTestNode.output_stream_url!) }

    if (testRun) { testRun = await waitForStates(TERMINAL_STATES, testRun, command) }

    // At this point, we know that testRun has a finished status,
    // and we can check for exit_code from firstTestNode
    if (testRun) {
      let {body: newTestNodes} = await command.heroku.get<Heroku.TestNode[]>(`/test-runs/${testRun.id}/test-nodes`)
      firstTestNode = newTestNodes[0]

      command.log()
      command.log(printLine(testRun))
    }
    return firstTestNode
  }
}

export async function displayAndExit(pipeline: Heroku.Pipeline, number: number, command: Command) {
  let testNode = await display(pipeline, number, command)

  testNode ? processExitCode(command, testNode) : command.exit(1)
}

export async function displayTestRunInfo(command: Command, testRun: Heroku.TestRun, testNodes: Heroku.TestNode[], nodeArg: string | undefined) {
  let testNode: Heroku.TestNode

  if (nodeArg) {
    const nodeIndex = parseInt(nodeArg, 2)
    testNode = testNodes.length > 1 ? testNodes[nodeIndex] : testNodes[0]

    await renderNodeOutput(command, testRun, testNode)

    if (testNodes.length === 1) {
      command.log()
      command.warn('This pipeline doesn\'t have parallel test runs, but you specified a node')
      command.warn('See https://devcenter.heroku.com/articles/heroku-ci-parallel-test-runs for more info')
    }
    processExitCode(command, testNode)
  } else {
    if (testNodes.length > 1) {
      command.log(printLine(testRun))
      command.log()

      testNodes.forEach(testNode => {
        command.log(printLineTestNode(testNode))
      })
    } else {
      testNode = testNodes[0]
      await renderNodeOutput(command, testRun, testNode)
      processExitCode(command, testNode)
    }
  }
}
