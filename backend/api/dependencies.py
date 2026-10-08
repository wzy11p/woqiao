from core.orchestrator import WorkflowEngine

workflow_engine = WorkflowEngine()


def get_workflow_engine() -> WorkflowEngine:
    return workflow_engine
