// Read the installed client's workflow container format without running or changing it.
// No account credentials, private workflow keys, or cloud writes are involved.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const app = process.argv[2];
if (!app) throw new Error('Usage: node scripts/import-dfcine-execution.mjs <installed DFCine directory>');
const asar = readFileSync(resolve(app, 'resources/app.asar'));
const index = JSON.parse(asar.subarray(16, 16 + asar.readUInt32LE(12)).toString());
const entry = index.files['dist-electron'].files.main.files['index.js'];
const offset = 8 + asar.readUInt32LE(4) + Number(entry.offset);
const loader = asar.subarray(offset, offset + entry.size).toString();
if (!loader.includes('createDecipheriv("aes-256-cbc"')) throw new Error('Unrecognized container reader');
const keyLiteral = loader.match(/\bTS\s*=\s*"([A-Za-z0-9+/=]+)"/)?.[1];
if (!keyLiteral) throw new Error('Installed version has no recognized default container key');
const key = Buffer.from(keyLiteral, 'base64');
if (key.length !== 32) throw new Error('Invalid container format');
const metadata = JSON.parse(readFileSync('src/workflow/original-configs.json', 'utf8'));
const definitions = {};
for (const [id, data] of Object.entries(metadata)) {
  const dir = resolve(app, 'workflows/library', data.original.folder);
  const rawConfig = readFileSync(resolve(dir, 'workflow.config.json'));
  if (createHash('sha256').update(rawConfig).digest('hex') !== data.original.configSha256) throw new Error('Configuration changed: ' + id);
  const config = JSON.parse(rawConfig.toString().replace(/^\uFEFF/, ''));
  const bytes = Buffer.from(readFileSync(resolve(dir, config.execution.file), 'utf8').trim(), 'base64');
  const decoder = createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16));
  const decoded = JSON.parse(Buffer.concat([decoder.update(bytes.subarray(16)), decoder.final()]).toString().replace(/^\uFEFF/, ''));
  const template = decoded.prompt ?? decoded;
  if (!Object.values(template).every(n => n.class_type && n.inputs)) throw new Error('Not an API graph: ' + id);
  const mapping = [], inputSlots = [], textParameters = [];
  function bind(semantic, binding, path = false) {
    if (!binding || binding.target !== 'comfyui' || !/^inputs\.[^.]+$/.test(binding.path)) throw new Error('Unsupported binding: ' + id + '/' + semantic);
    let field = binding.path.slice(7);
    const nodeId = binding.nodeId;
    const node = template[nodeId];
    // This original config calls Qwen's prompt port "text"; both the graph and
    // the server schema name it "prompt". Preserve the graph's actual contract.
    if (node?.class_type === 'TextEncodeQwenImageEditPlus' && field === 'text' && !('text' in node.inputs) && 'prompt' in node.inputs) field = 'prompt';
    if (!node || !(field in node.inputs) || Array.isArray(node.inputs[field])) throw new Error('Invalid binding: ' + id + '/' + semantic);
    const map = {semantic, nodeId, field};
    if (path && ['Image Load', 'VHS_LoadImagePath', 'VHS_LoadVideoPath', 'VHS_LoadAudio'].includes(node.class_type)) map.pathMode = 'comfy-input';
    mapping.push(map);
  }
  if (config.prompt?.binding) bind('prompt', config.prompt.binding);
  for (const parameter of config.parameters) bind(parameter.id, parameter.binding);
  for (const input of config.inputs) {
    if (config.dynamicInput?.enabled) continue;
    const semantic = 'slot:' + input.id;
    if (input.dataType === 'text') {
      bind(semantic, input.binding);
      textParameters.push({key:semantic, label:input.description || input.name, type:'text', default:'', multiline:true, required:!!input.required, inputText:true});
    } else {
      if (!['image','video','audio'].includes(input.dataType)) throw new Error('Unsupported input kind: ' + id);
      bind(semantic, input.binding, true);
      // Remove source-machine example paths. Every required input must come from the canvas.
      template[input.binding.nodeId].inputs[input.binding.path.slice(7)] = '';
      inputSlots.push({semantic, label:input.description || input.name, kind:input.dataType, required:!!input.required});
    }
  }
  const outputs = Object.entries(template).filter(([,n]) => ['SaveImage','SaveVideo','SaveAudio','SaveAudioMP3','SaveAudioAdvanced','VHS_VideoCombine'].includes(n.class_type));
  if (outputs.length !== 1) throw new Error('Ambiguous final output: ' + id);
  const [nodeId, outputNode] = outputs[0];
  const kind = config.nodeKind;
  if (outputNode.class_type === 'VHS_VideoCombine') outputNode.inputs.save_output = true;
  definitions[id] = {
    template, mapping, inputSlots, textParameters, promptRequired:!!config.prompt?.binding,
    dynamicReferences: config.dynamicInput?.enabled ? config.dynamicInput : undefined,
    output: {nodeId, field:outputNode.class_type === 'VHS_VideoCombine' ? 'gifs' : kind === 'audio' ? 'audio' : 'images', kind},
  };
}
writeFileSync('src/workflow/original-execution.gz.json', JSON.stringify(gzipSync(JSON.stringify(definitions)).toString('base64')) + '\n');
console.log(JSON.stringify({boundEntries:Object.keys(definitions).length, cloudWrites:0, generationTasks:0}));
