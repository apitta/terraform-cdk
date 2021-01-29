/* eslint-disable no-control-regex */
import React from 'react'
import * as path from 'path'
import { TerraformCli } from "./models/terraform-cli"
import { TerraformCloud, TerraformCloudPlan } from "./models/terraform-cloud"
import { Terraform, DeployingResource, DeployingResourceApplyState, PlannedResourceAction, PlannedResource, TerraformPlan, TerraformOutput } from './models/terraform'
import { SynthStack } from '../helper/synth-stack'
import { TerraformJson } from './terraform-json'
import { useApp } from 'ink'

type DefaultValue = undefined;
type ContextValue = DefaultValue | DeployState;

const TerraformContextState = React.createContext<ContextValue>(undefined)
// eslint-disable-next-line @typescript-eslint/no-empty-function
const TerraformContextDispatch = React.createContext((() => { }) as React.Dispatch<Action>);

export enum Status {
  STARTING = 'starting',
  SYNTHESIZING = 'synthesizing',
  SYNTHESIZED = 'synthesized',
  INITIALIZING = 'initializing',
  PLANNING = 'planning',
  PLANNED = 'planned',
  DEPLOYING = 'deploying',
  DESTROYING = 'destroying',
  DONE = 'done'
}

const stripAnsi = (str: string): string => {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
}

const parseOutput = (str: string): DeployingResource[] => {
  const lines = stripAnsi(str.toString()).split('\n')

  const resources = lines.map(line => {

    if (/^Outputs:/.test(line)) { return }
    if (/^data\..*/.test(line)) { return }

    const resourceMatch = line.match(/^([a-zA-Z\d_.]*):/)
    let applyState: DeployingResourceApplyState;

    switch (true) {
      case /Creating.../.test(line):
        applyState = DeployingResourceApplyState.CREATING
        break;
      case /Creation complete/.test(line):
        applyState = DeployingResourceApplyState.CREATED
        break;
      case /Modifying.../.test(line):
        applyState = DeployingResourceApplyState.UPDATING
        break;
      case /Modifications complete/.test(line):
        applyState = DeployingResourceApplyState.UPDATED
        break;
      case /Destroying.../.test(line):
        applyState = DeployingResourceApplyState.DESTROYING
        break;
      case /Destruction complete/.test(line):
        applyState = DeployingResourceApplyState.DESTROYED
        break;
      default:
        applyState = DeployingResourceApplyState.WAITING
    }

    if (resourceMatch && resourceMatch.length >= 0) {
      return {
        id: resourceMatch[1],
        action: PlannedResourceAction.CREATE,
        applyState
      }
    } else {
      return
    }
  })

  return resources.reduce((acc, resource) => {
    if (resource) {
      acc.push(resource)
    }
    return acc
  // eslint-disable-next-line @typescript-eslint/no-array-constructor
  }, new Array)
}

export type DeployState = {
  status: Status;
  resources: DeployingResource[];
  plan?: TerraformPlan;
  url?: string;
  stackName?: string;
  stackJSON?: string;
  errors?: string[];
  output?: { [key: string]: TerraformOutput };
}

type Action =
  | { type: 'SYNTH' }
  | { type: 'NEW_STACK'; stackName: string; stackJSON: string }
  | { type: 'INIT' }
  | { type: 'PLAN' }
  | { type: 'PLANNED'; plan: TerraformPlan }
  | { type: 'DEPLOY'; resources: DeployingResource[] }
  | { type: 'DESTROY'; resources: DeployingResource[] }
  | { type: 'UPDATE_RESOURCES'; resources: DeployingResource[] }
  | { type: 'OUTPUT'; output: { [key: string]: TerraformOutput } }
  | { type: 'DONE' }
  | { type: 'ERROR'; error: string };


function deployReducer(state: DeployState, action: Action): DeployState {
  switch (action.type) {
    case 'UPDATE_RESOURCES': {
      const map = new Map<string, DeployingResource>(
        state.resources.map(r => [r.id, r])
      )
      action.resources.forEach(r => map.set(r.id, r))
      return {
        ...state,
        resources: [...map.values()]
      }
    }
    case 'SYNTH': {
      return { ...state, status: Status.SYNTHESIZING }
    }
    case 'NEW_STACK': {
      return {
        ...state,
        status: Status.SYNTHESIZED,
        stackName: action.stackName,
        stackJSON: action.stackJSON
      }
    }
    case 'INIT': {
      return { ...state, status: Status.INITIALIZING }
    }
    case 'PLAN': {
      return { ...state, status: Status.PLANNING }
    }
    case 'PLANNED': {
      if (action.plan instanceof TerraformCloudPlan) {
        return {
          ...state,
          status: Status.PLANNED,
          plan: action.plan,
          url: action.plan.url
        }
      } else {
        return {
          ...state,
          status: Status.PLANNED,
          plan: action.plan,
        }
      }
    }
    case 'DEPLOY': {
      return { ...state, status: Status.DEPLOYING, resources: action.resources }
    }
    case 'DESTROY': {
      return { ...state, status: Status.DESTROYING, resources: action.resources }
    }
    case 'OUTPUT': {
      return { ...state, output: action.output }
    }
    case 'DONE': {
      return { ...state, status: Status.DONE }
    }
    case 'ERROR': {
      return { ...state, errors: [...(Array.isArray(state.errors) ? state.errors : []), action.error] }
    }
    default: {
      throw new Error(`Unhandled action type: ${JSON.stringify(action, null, 2)}`)
    }
  }
}

interface TerraformProviderConfig {
  initialState?: DeployState;
}

// eslint-disable-next-line react/prop-types
export const TerraformProvider: React.FunctionComponent<TerraformProviderConfig> = ({ children, initialState }): React.ReactElement => {
  const [state, dispatch] = React.useReducer(deployReducer, initialState || { status: Status.STARTING, resources: [] })

  return (
    <TerraformContextState.Provider value={state}>
      <TerraformContextDispatch.Provider value={dispatch}>
        {children}
      </TerraformContextDispatch.Provider>
    </TerraformContextState.Provider>
  )
}
interface UseTerraformInput {
  targetDir: string;
  synthCommand: string;
  isSpeculative?: boolean;
  autoApprove?: boolean;
}

export const useTerraformState = () => {
  const state = React.useContext(TerraformContextState)

  if (state === undefined) {
    throw new Error('useTerraformState must be used within a TerraformContextState.Provider')
  }

  return state
}

export const useTerraform = ({ targetDir, synthCommand, isSpeculative = false, autoApprove = false }: UseTerraformInput) => {
  const dispatch = React.useContext(TerraformContextDispatch)
  const state = useTerraformState()
  const [terraform, setTerraform] = React.useState<Terraform>()
  const [confirmed, setConfirmed] = React.useState<boolean>(autoApprove)
  const { exit } = useApp()

  if (dispatch === undefined) {
    throw new Error('useTerraform must be used within a TerraformContextDispatch.Provider')
  }


  const confirmationCallback = React.useCallback(submitValue => {
    if (submitValue === false) {
      exit()
      return
    }

    setConfirmed(submitValue)
  }, []);


  const excecutorForStack = async (stackJSON: string): Promise<void> => {
    if (stackJSON === undefined) throw new Error('no synthesized stack found');
    const cwd = process.cwd();
    const outdir = path.join(cwd, targetDir);
    const stack = JSON.parse(stackJSON) as TerraformJson

    if (stack.terraform?.backend?.remote) {
      const tfClient = new TerraformCloud(outdir, stack.terraform?.backend?.remote, isSpeculative)
      if (await tfClient.isRemoteWorkspace()) {
        setTerraform(tfClient)
      } else {
        setTerraform(new TerraformCli(outdir))
      }
    } else {
      setTerraform(new TerraformCli(outdir))
    }
  }

  const execTerraformSynth = async (loadExecutor = true) => {
    try {
      dispatch({ type: 'SYNTH' })
      const stacks = await SynthStack.synth(synthCommand, targetDir);
      if (loadExecutor) {
        await excecutorForStack(stacks[0].content)
      }
      dispatch({ type: 'NEW_STACK', stackName: stacks[0].name, stackJSON: stacks[0].content })
    } catch (e) {
      dispatch({ type: 'ERROR', error: e })
    }
  }

  const execTerraformInit = async () => {
    try {
      if (!terraform) throw new Error('Terraform is not initialized yet');
      dispatch({ type: 'INIT' })
      await terraform.init();
    } catch (e) {
      dispatch({ type: 'ERROR', error: e })
    }
  }

  const execTerraformOutput = async () => {
    try {
      if (!terraform) throw new Error('Terraform is not initialized yet');
      const output = await terraform.output();
      dispatch({ type: 'OUTPUT', output })
    } catch (e) {
      dispatch({ type: 'ERROR', error: e })
    }
  }

  const execTerraformPlan = async (destroy = false): Promise<TerraformPlan | undefined> => {
    let plan: TerraformPlan
    try {
      if (!terraform) throw new Error('Terraform is not initialized yet');
      dispatch({ type: 'PLAN' })
      plan = await terraform.plan(destroy);
      dispatch({ type: 'PLANNED', plan })
      return plan
    } catch (e) {
      dispatch({ type: 'ERROR', error: e })
    }
    return
  }

  const execTerraformApply = async () => {
    const plan = state.plan
    try {
      if (!terraform) throw new Error('Terraform is not initialized yet');
      if (!plan) throw new Error('No plan');
      if (plan.needsApply) {
        const resources: DeployingResource[] = plan.applyableResources.map((r: PlannedResource) => (Object.assign({}, r, { applyState: DeployingResourceApplyState.WAITING })))
        dispatch({ type: 'DEPLOY', resources })
        await terraform.deploy(plan.planFile, (output: Buffer) => {
          const resources = parseOutput(output.toString());
          dispatch({ type: 'UPDATE_RESOURCES', resources })
        });
      }
      dispatch({ type: 'DONE' })
    } catch (e) {
      dispatch({ type: 'ERROR', error: e })
    }
  }

  const execTerraformDestroy = async () => {
    const plan = state.plan
    try {
      if (!terraform) throw new Error('Terraform is not initialized yet');
      if (!plan) throw new Error('No plan');
      if (plan.needsApply) {
        const resources: DeployingResource[] = plan.applyableResources.map((r: PlannedResource) => (Object.assign({}, r, { applyState: DeployingResourceApplyState.WAITING })))
        dispatch({ type: 'DESTROY', resources })

        await terraform.destroy((output: Buffer) => {
          const resources = parseOutput(output.toString());
          dispatch({ type: 'UPDATE_RESOURCES', resources })
        });
      }
      dispatch({ type: 'DONE' })
    } catch (e) {
      dispatch({ type: 'ERROR', error: e })
    }
  }

  const synth = () => {
    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformSynth(false)
      }

      invoke()
    }, [])

    return state
  }

  const init = () => {
    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformSynth()
      }
      invoke()
    }, [])


    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformInit()
      }

      if (state.status === Status.SYNTHESIZED) invoke();
    }, [state.status, terraform])

    return state
  }

  const plan = () => {
    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformSynth()
      }
      invoke()
    }, [])

    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformInit()
        await execTerraformPlan()
      }
      if (state.status === Status.SYNTHESIZED) invoke();
    }, [state.status, terraform])

    return state
  }

  const deploy = () => {
    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformSynth()
      }
      invoke()
    }, [])

    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformInit()
        await execTerraformPlan(false)
      }
      if (state.status === Status.SYNTHESIZED) invoke();
    }, [state.status, terraform])

    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformApply()
        await execTerraformOutput()
      }
      if (confirmed && state.status === Status.PLANNED) invoke();
    }, [terraform, confirmed, state.status])

    return {
      state,
      confirmation: confirmationCallback,
      isConfirmed: confirmed
    }
  }

  const destroy = () => {
    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformSynth()
      }
      invoke()
    }, [])

    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformInit()
        await execTerraformPlan(true)
      }
      if (state.status === Status.SYNTHESIZED) invoke();
    }, [state.status, terraform])

    React.useEffect(() => {
      const invoke = async () => {
        await execTerraformDestroy()
      }

      if (confirmed && state.status === Status.PLANNED) invoke();
    }, [terraform, confirmed, state.status])

    return {
      state,
      confirmation: confirmationCallback,
      isConfirmed: confirmed
    }
  }

  return {
    synth,
    init,
    plan,
    deploy,
    destroy
  }
}
