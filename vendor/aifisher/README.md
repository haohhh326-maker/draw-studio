# AIFISHER workflow reader source

The JavaScript, `LICENSE` and `THIRD-PARTY-NOTICES.md` listed in `SOURCE.json`
are byte-for-byte copies of Work-Fisher/AIFISHER revision
`bdcf3bec054594fcab591952a8c5acef858d6de4`.

The adjacent `.d.ts` files and the application's `scripts/aifisher-workflow-reader*`
and `scripts/aifisher-runninghub-import.ts` are integration boundaries written for
this application. They do not modify the upstream JavaScript.

RunningHub imports instantiate the complete original `RunningHubWorkflowClient`,
`RunningHubWebAppLibraryService`, `WorkflowDefinitionStore`,
`WorkflowConfigurationStore`, `WorkflowDeploymentService` and
`WorkflowCanvasNodeService`. The full relative JavaScript import closure is
retained here, with the real `sharp`, `node-fetch`, `form-data` and `ws`
dependencies declared by the application. There is no source extraction,
declaration rebuilding or textual substitution.

The host supplies a read-only HTTPS transport without a request deadline and
passes through explicit caller cancellation. It translates Node response streams
to standard Response streams expected by the unchanged client. Author credential
defaults are cleared before projection or storage, and account authentication
never enters the stored configuration. These are host security boundaries.
Original stores run in a unique `.cache/aifisher-read-UUID` directory, which is
removed after each import. The user's workflow library is never used by these
temporary services.

Local ComfyUI analysis consumes the source artifact and supplied `object_info`.
RunningHub WebApp import uses the original library service's projection, field
selection, `field_*` binding keys, binding compiler and canvas blueprint. Native
API workflow import uses the original definition, deployment, portable schema,
binding-set and canvas services; its binding keys use the compiler's `input_*`
defaults. Both return the original raw bindings, public binding DTO and canvas
contracts. Source field and binding limits remain those of the original services.

ComfyUI final outputs are read from a successful completed history receipt by
the unchanged upstream output reader. Output candidate nodes alone do not prove
whether a finished file is an image or a video. The original source license is
noncommercial and is retained in full; it is not an OSI open-source license.
