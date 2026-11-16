"""Adapter contract tests. Runtime doubles are NOT a real AI model test."""
import asyncio
import ast
import base64
import dataclasses
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import types
import typing
import unittest
import zipfile
from unittest.mock import patch

from PIL import Image


class Routes:
    def get(self, path):
        return lambda fn: fn

    post = get


class Response:
    def __init__(self, body, status=200):
        self.body, self.status = body, status


folder_paths = types.ModuleType("folder_paths")
folder_paths.models_dir = ""
server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=Routes()))
aiohttp = types.ModuleType("aiohttp")
aiohttp.web = types.SimpleNamespace(json_response=lambda body, status=200: Response(body, status))
location = Path(__file__).resolve().parents[1] / "comfyui" / "draw-studio-prompt-optimizer" / "__init__.py"
with patch.dict(sys.modules, {"folder_paths": folder_paths, "server": server, "aiohttp": aiohttp}):
    spec = importlib.util.spec_from_file_location("draw_optimizer_adapter_test", location)
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)


def gguf(path, architecture, extra=None):
    def string(text):
        data = text.encode("utf-8")
        return struct.pack("<Q", len(data)) + data
    entries = []
    for key, kind, value in extra or []:
        entries.append((key, kind, string(value) if kind == 8 and isinstance(value, str) else value))
    entries.append(("general.architecture", 8, string(architecture)))
    data = b"GGUF" + struct.pack("<IQQ", 3, 0, len(entries))
    for key, kind, value in entries:
        data += string(key) + struct.pack("<I", kind) + value
    path.write_bytes(data)


def image_url():
    output = io.BytesIO()
    Image.new("RGB", (4, 3), (23, 44, 55)).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def payload(images=False):
    user = [{"type": "text", "text": '{"editable_prompt":"向前走","target":{"mode":"multi-reference"}}'}]
    if images:
        user += [{"type": "text", "text": '{"role":"characterReference"}'},
                 {"type": "image_url", "image_url": {"url": image_url()}}]
    return {"model": "test.gguf", "device": "cuda", "request_id": "unique",
            "mmproj": "mmproj.gguf", "messages": [{"role": "system", "content": "Optimize."}, {"role": "user", "content": user}]}


def wheel_chat_formatter():
    """Execute the actual Python formatter, without importing a Linux .so.

    This optional integration fixture uses the same wheel installed remotely;
    it performs real Jinja rendering, not model inference or a formatter double.
    """
    try:
        import jinja2
        import jinja2.ext
        from jinja2.sandbox import ImmutableSandboxedEnvironment
    except ImportError as error:
        raise unittest.SkipTest("Jinja2 is required for the real wheel formatter regression") from error
    wheel = location.parents[2] / ".cache" / "llama_cpp_python-0.4.2+cu130-cp312-cp312-linux_x86_64.whl"
    if not wheel.is_file():
        raise unittest.SkipTest("The exact remotely installed wheel fixture is not available")
    with zipfile.ZipFile(wheel) as archive:
        source = ast.parse(archive.read("llama_cpp/llama_chat_format.py").decode("utf-8"))
        multimodal = ast.parse(archive.read("llama_cpp/llama_multimodal.py").decode("utf-8"))
    names = {"ChatFormatterResponse", "ChatFormatter", "Jinja2ChatFormatter", "chat_formatter_to_chat_completion_handler",
             "_convert_completion_to_chat", "_convert_text_completion_to_chat", "_convert_text_completion_logprobs_to_chat"}
    selected = [node for node in source.body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names]
    module = types.ModuleType("draw_optimizer_wheel_chat_format_test")
    module.__dict__.update({"dataclasses": dataclasses, "datetime": datetime, "jinja2": jinja2, "json": json,
                            "Protocol": typing.Protocol, "Extension": jinja2.ext.Extension,
                            "ImmutableSandboxedEnvironment": ImmutableSandboxedEnvironment,
                            "llama_core": types.SimpleNamespace(StoppingCriteriaList=list)})
    mtmd = next(node for node in multimodal.body if isinstance(node, ast.ClassDef) and node.name == "MTMDChatHandler")
    mtmd_call = next(node for node in mtmd.body if isinstance(node, ast.FunctionDef) and node.name == "__call__")
    mtmd_call.name = "mtmd_chat_handler_call"
    body = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *selected, mtmd_call]
    with patch.dict(sys.modules, {module.__name__: module}):
        exec(compile(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])), str(wheel), "exec"), module.__dict__)
    qwen = next(node for node in multimodal.body if isinstance(node, ast.ClassDef) and node.name == "Qwen35ChatHandler")
    assignment = next(node for node in qwen.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "CHAT_FORMAT" for target in node.targets))
    return module, ast.literal_eval(assignment.value)


class Request:
    def __init__(self, body=None, headers=None, host="127.0.0.1:8188", remote="127.0.0.1", query=None):
        raw = body if isinstance(body, bytes) else json.dumps(body or {}).encode()
        self.host, self.remote, self.headers = host, remote, headers or {}
        self.query = query or {}
        self.content_type, self.content_length = "application/json", len(raw)
        self.transport = types.SimpleNamespace(is_closing=lambda: False)

        async def chunks(size):
            for position in range(0, len(raw), size):
                yield raw[position:position + size]
        self.content = types.SimpleNamespace(iter_chunked=chunks)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        adapter.folder_paths.models_dir = str(self.root)
        self.llm = self.root / "LLM"
        self.llm.mkdir()
        # The baseline pair is matched through real GGUF identity metadata,
        # rather than guessing that every projector works with every Qwen file.
        gguf(self.llm / "test.gguf", "qwen35", [("general.name", 8, "Qwen3.8-27B-Instruct")])
        gguf(self.llm / "mmproj.gguf", "clip", [("general.name", 8, "Qwen3.8-27B-Instruct")])
        adapter._CANCEL.clear()
        adapter._JOBS.clear()

    def tearDown(self):
        self.assertFalse(adapter._LOCK.locked(), "Inference lock leaked")
        self.temp.cleanup()

    def fake_runtime(self, completion=None, close_error=False, generate_error=False, on_sample=None):
        calls, exits = [], []
        runtime = types.ModuleType("llama_cpp")
        runtime.__version__ = "test-double"

        class Handler:
            def __init__(self, **kwargs):
                calls.append(("handler", kwargs))
                self._exit_stack = types.SimpleNamespace(close=lambda: exits.append("handler"))

            def __call__(self, *, llama, messages, max_tokens=None, temperature=0.2):
                prepared = self._process_mtmd_prompt(llama=llama, messages=messages)
                try:
                    calls.append(("media_eval", True))
                    return llama.create_completion(prompt=prepared[0], max_tokens=max_tokens, temperature=temperature)
                finally:
                    self._free_mtmd_resources(prepared[2], prepared[3])

            def _process_mtmd_prompt(self, llama, messages, **kwargs):
                calls.append(("media_prepare", True))
                return [1] * getattr(runtime, "media_tokens", 64), [], "owned-chunks", ["owned-bitmap"]

            def _init_mtmd_context(self, llama):
                self.mtmd_ctx = object()

            def _free_mtmd_resources(self, chunks, bitmaps):
                calls.append(("media_free", {"chunks": chunks, "bitmaps": bitmaps}))

        class Llama:
            def __init__(self, **kwargs):
                calls.append(("llama", kwargs))
                runtime.last_llm = self
                self.chat_handler = kwargs.get("chat_handler")
                self._n_ctx = kwargs["n_ctx"]
                self.chat_format = "chat_template.default"
                self.metadata = {"tokenizer.chat_template": "{% if enable_thinking is not defined or enable_thinking %}<think>{% else %}<think></think>{% endif %}"}
                self._model = types.SimpleNamespace(token_get_text=lambda token: {1: "<bos>", 2: "<eos>", 3: "<eot>"}.get(token, ""),
                                                    get_add_bos=lambda: False, get_add_eos=lambda: False, get_add_sep=lambda: False)

            def n_ctx(self):
                return self._n_ctx

            def n_ctx_train(self):
                return 262144

            def tokenize(self, text, add_bos=True, special=False):
                return list(text)

            def token_bos(self):
                return 1

            def token_eos(self):
                return 2

            def token_eot(self):
                return 3

            def create_chat_completion(self, messages, max_tokens=None, temperature=0.2):
                calls.append(("completion", {"messages": messages, "max_tokens": max_tokens,
                                             "temperature": temperature}))
                if self.chat_handler is not None:
                    return self.chat_handler(llama=self, messages=messages, max_tokens=max_tokens, temperature=temperature)
                return self.create_completion(prompt="formatted messages", max_tokens=max_tokens, temperature=temperature)

            def create_completion(self, prompt, max_tokens=None, temperature=0.2, stopping_criteria=None, **kwargs):
                if generate_error:
                    raise RuntimeError("controlled failure")
                if on_sample:
                    on_sample()
                calls.append(("sampling", {"max_tokens": max_tokens, "temperature": temperature,
                                           "stopping_criteria": stopping_criteria, **kwargs}))
                calls.append(("stopped", any(criteria([], []) for criteria in stopping_criteria or [])))
                return completion or {"choices": [{"finish_reason": "stop", "message": {"content": "人物平稳向前走。"}}]}

            def close(self):
                exits.append("llama")
                if close_error:
                    raise RuntimeError("controlled close failure")

        class Formatter:
            def __init__(self, template, eos_token, bos_token, stop_token_ids=None, special_tokens_map=None):
                calls.append(("formatter", {"template": template, "eos_token": eos_token, "bos_token": bos_token,
                                            "stop_token_ids": stop_token_ids, "special_tokens_map": special_tokens_map}))

            def __call__(self, **kwargs):
                calls.append(("format", kwargs))
                return types.SimpleNamespace(prompt="formatted messages", stopping_criteria=[])

        def convert(formatter):
            def chat(*, llama, messages, max_tokens=None, temperature=0.2):
                rendered = formatter(messages=messages)
                return llama.create_completion(prompt=rendered.prompt, max_tokens=max_tokens, temperature=temperature,
                                               stopping_criteria=rendered.stopping_criteria)
            return chat

        runtime.Llama, runtime.StoppingCriteriaList = Llama, list
        runtime.llama_supports_gpu_offload = lambda: True
        runtime.llama_chat_format = types.SimpleNamespace(Qwen35ChatHandler=Handler, Qwen3VLChatHandler=Handler,
                                                        Jinja2ChatFormatter=Formatter,
                                                        chat_formatter_to_chat_completion_handler=convert)
        return runtime, calls, exits

    def test_inventory_reads_architecture_without_filename_guess(self):
        gguf(self.llm / "misleading-vision-name.gguf", "llama")
        models, projectors, warnings = adapter._inventory()
        self.assertEqual(models["test.gguf"]["architecture"], "qwen35")
        self.assertEqual(models["test.gguf"]["metadata"]["general.name"], "Qwen3.8-27B-Instruct")
        self.assertEqual(models["misleading-vision-name.gguf"]["architecture"], "llama")
        self.assertEqual(list(projectors), ["mmproj.gguf"])
        self.assertFalse(warnings)

    def test_mmproj_candidates_use_metadata_or_conservative_filename_family(self):
        gguf(self.llm / "wrong-size-projector.gguf", "clip", [("general.name", 8, "Qwen3.8-7B")])
        models, projectors, _ = adapter._inventory()
        candidates, recommendation = adapter._compatible_mmproj_candidates(models["test.gguf"], projectors)
        self.assertEqual(candidates, [{"id": "mmproj.gguf", "match": "metadata-exact", "confidence": "high"}])
        self.assertEqual(recommendation, "mmproj.gguf")

        gguf(self.llm / "Qwen3.8-27B-Uncensored-Q4_K_M.gguf", "qwen35")
        gguf(self.llm / "mmproj-Qwen3.8-27B-F16.gguf", "clip")
        models, projectors, _ = adapter._inventory()
        candidates, recommendation = adapter._compatible_mmproj_candidates(models["Qwen3.8-27B-Uncensored-Q4_K_M.gguf"], projectors)
        self.assertEqual(candidates, [
            {"id": "mmproj-Qwen3.8-27B-F16.gguf", "match": "family-and-size", "confidence": "medium"},
            {"id": "mmproj.gguf", "match": "family-and-size", "confidence": "medium"},
        ])
        self.assertIsNone(recommendation)

    def test_equal_strength_mmproj_candidates_have_no_auto_recommendation(self):
        gguf(self.llm / "mmproj-alternate.gguf", "clip", [("general.name", 8, "Qwen3.8-27B-Instruct")])
        models, projectors, _ = adapter._inventory()
        candidates, recommendation = adapter._compatible_mmproj_candidates(models["test.gguf"], projectors)
        self.assertEqual([candidate["id"] for candidate in candidates], ["mmproj-alternate.gguf", "mmproj.gguf"])
        self.assertIsNone(recommendation)

    def test_gguf_skip_numeric_array_metadata(self):
        gguf(self.llm / "array.gguf", "qwen3vl", [("sample", 9, struct.pack("<IQIII", 4, 3, 7, 8, 9))])
        self.assertEqual(adapter._gguf_architecture(self.llm / "array.gguf"), "qwen3vl")

    def test_truncated_and_excess_metadata_ignored(self):
        (self.llm / "broken.gguf").write_bytes(b"GGUF")
        (self.llm / "too-many.gguf").write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 9000))
        models, _, warnings = adapter._inventory()
        self.assertEqual(list(models), ["test.gguf"])
        self.assertEqual(len(warnings), 2)

    def test_unknown_qwen2_is_not_qwen3_handler(self):
        self.assertIsNone(adapter._handler_name("qwen2vl"))
        self.assertEqual(adapter._handler_name("qwen3vl"), "Qwen3VLChatHandler")

    def test_generic_qwen3_architecture_can_use_explicit_h3_qwen38_identity(self):
        gguf(self.llm / "Qwen3.8-27B-UD-Q2_K_XL.gguf", "qwen3")
        gguf(self.llm / "mmproj-Qwen3.8-27B-F16.gguf", "clip")
        gguf(self.llm / "Qwen3.8-but-actually-llama.gguf", "llama")
        models, projectors, _ = adapter._inventory()
        selected = models["Qwen3.8-27B-UD-Q2_K_XL.gguf"]
        self.assertEqual(adapter._handler_info(selected["architecture"], selected), ("Qwen35ChatHandler", "model-name"))
        candidates, _ = adapter._compatible_mmproj_candidates(selected, projectors)
        self.assertIn("mmproj-Qwen3.8-27B-F16.gguf", [candidate["id"] for candidate in candidates])
        self.assertEqual(adapter._handler_info(models["Qwen3.8-but-actually-llama.gguf"]["architecture"], models["Qwen3.8-but-actually-llama.gguf"]), (None, None))

    def test_containment_denies_outside(self):
        self.assertFalse(adapter._contained(self.llm, self.root / "outside.gguf"))

    def test_inventory_skips_symlink(self):
        outside = self.root / "outside.gguf"
        gguf(outside, "llama")
        try:
            (self.llm / "linked.gguf").symlink_to(outside)
        except OSError:
            self.skipTest("Windows symlink privilege unavailable")
        self.assertNotIn("linked.gguf", adapter._inventory()[0])

    def test_inventory_accepts_allowed_leaf_cache_links_with_extensionless_targets(self):
        cache = self.root / "autodl-cache"
        cache.mkdir()
        model = cache / "model-shard"
        projector = cache / "projector-shard"
        gguf(model, "qwen35", [("general.name", 8, "Qwen3.8-27B-Instruct")])
        gguf(projector, "clip", [("general.name", 8, "Qwen3.8-27B-Instruct")])
        try:
            (self.llm / "cached-model.gguf").symlink_to(model)
            (self.llm / "cached-mmproj.gguf").symlink_to(projector)
        except OSError:
            self.skipTest("Windows symlink privilege unavailable")

        with patch.dict(os.environ, {adapter._ALLOWED_MODEL_ROOTS_ENV: str(cache)}):
            models, projectors, warnings = adapter._inventory()

        self.assertFalse(warnings)
        self.assertEqual(models["cached-model.gguf"]["path"], model.resolve())
        self.assertEqual(projectors["cached-mmproj.gguf"]["path"], projector.resolve())
        candidates, _ = adapter._compatible_mmproj_candidates(models["cached-model.gguf"], projectors)
        self.assertIn("cached-mmproj.gguf", [candidate["id"] for candidate in candidates])

    def test_inventory_rejects_unconfigured_or_escaped_cache_links(self):
        cache, outside = self.root / "autodl-cache", self.root / "outside-cache"
        cache.mkdir()
        outside.mkdir()
        allowed_target, escaped_target = cache / "allowed-shard", outside / "outside-shard"
        gguf(allowed_target, "qwen35")
        gguf(escaped_target, "qwen35")
        try:
            indirect = cache / "indirect-shard"
            indirect.symlink_to(escaped_target)
            (self.llm / "unconfigured.gguf").symlink_to(allowed_target)
            (self.llm / "escaped.gguf").symlink_to(indirect)
        except OSError:
            self.skipTest("Windows symlink privilege unavailable")

        self.assertNotIn("unconfigured.gguf", adapter._inventory()[0])
        with patch.dict(os.environ, {adapter._ALLOWED_MODEL_ROOTS_ENV: str(cache)}):
            models, _, _ = adapter._inventory()
        self.assertIn("unconfigured.gguf", models)
        self.assertNotIn("escaped.gguf", models)

    def test_inventory_never_follows_cache_directory_links(self):
        cache = self.root / "autodl-cache"
        nested = cache / "nested"
        nested.mkdir(parents=True)
        gguf(nested / "hidden.gguf", "qwen35")
        try:
            (self.llm / "cache-directory").symlink_to(nested, target_is_directory=True)
        except OSError:
            self.skipTest("Windows symlink privilege unavailable")

        with patch.dict(os.environ, {adapter._ALLOWED_MODEL_ROOTS_ENV: str(cache)}):
            models, _, _ = adapter._inventory()
        self.assertNotIn("cache-directory/hidden.gguf", models)

    def test_allowed_model_roots_reject_relative_and_filesystem_root(self):
        cache = self.root / "autodl-cache"
        cache.mkdir()
        with patch.dict(os.environ, {adapter._ALLOWED_MODEL_ROOTS_ENV: os.pathsep.join(("relative-cache", str(Path(cache.anchor)), str(cache)))}):
            self.assertEqual(adapter._allowed_model_roots(), [cache.resolve()])

    def test_generate_uses_verified_resolved_cache_paths(self):
        cache = self.root / "autodl-cache"
        cache.mkdir()
        model = cache / "model-shard"
        projector = cache / "projector-shard"
        gguf(model, "qwen35", [("general.name", 8, "Qwen3.8-27B-Instruct")])
        gguf(projector, "clip", [("general.name", 8, "Qwen3.8-27B-Instruct")])
        try:
            (self.llm / "cached-model.gguf").symlink_to(model)
            (self.llm / "cached-mmproj.gguf").symlink_to(projector)
        except OSError:
            self.skipTest("Windows symlink privilege unavailable")
        runtime, calls, _ = self.fake_runtime()
        data = payload(True)
        data.update({"model": "cached-model.gguf", "mmproj": "cached-mmproj.gguf"})

        with patch.dict(os.environ, {adapter._ALLOWED_MODEL_ROOTS_ENV: str(cache)}), patch.dict(sys.modules, {"llama_cpp": runtime}):
            adapter._generate(data, threading.Event())

        self.assertEqual(dict(calls)["llama"]["model_path"], str(model.resolve()))
        self.assertEqual(dict(calls)["handler"]["clip_model_path"], str(projector.resolve()))

    def test_real_pixels_validated(self):
        self.assertEqual(adapter._validate(payload(True)), 1)
        invalid = payload(True)
        invalid["messages"][1]["content"][-1]["image_url"]["url"] = "data:image/png;base64," + base64.b64encode(b"PNG filename only").decode()
        with self.assertRaisesRegex(ValueError, "有效"):
            adapter._validate(invalid)

    def test_external_image_and_mismatched_type_rejected(self):
        invalid = payload(True)
        invalid["messages"][1]["content"][-1]["image_url"]["url"] = "https://example.invalid/x.png"
        with self.assertRaisesRegex(ValueError, "外部网址"):
            adapter._validate(invalid)
        invalid["messages"][1]["content"][-1]["image_url"]["url"] = image_url().replace("image/png", "image/jpeg")
        with self.assertRaisesRegex(ValueError, "有效"):
            adapter._validate(invalid)

    def test_max_images_and_encoded_bytes_bounded(self):
        invalid = payload(True)
        part = invalid["messages"][1]["content"][-1]
        invalid["messages"][1]["content"] = [part] * 17
        with self.assertRaisesRegex(ValueError, "16"):
            adapter._validate(invalid)
        with patch.object(adapter, "_MAX_IMAGE_DATA", 1):
            with self.assertRaisesRegex(ValueError, "20 MiB"):
                adapter._validate(payload(True))

    def test_max_tokens_are_bounded_and_forwarded_to_llama(self):
        runtime, calls, _ = self.fake_runtime()
        data = payload()
        data["max_tokens"] = 512
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            adapter._generate(data, threading.Event())
        self.assertEqual(dict(calls)["completion"]["max_tokens"], 512)
        accepted = payload()
        accepted["max_tokens"] = 10000
        self.assertEqual(adapter._validate(accepted), 0)
        for invalid_value in (True, 511, 10001, 4096.0, "4096"):
            invalid = payload()
            invalid["max_tokens"] = invalid_value
            with self.assertRaisesRegex(ValueError, "512 至 10000"):
                adapter._validate(invalid)

    def test_malformed_messages_and_tools_rejected(self):
        cases = [{}, {"messages": [None, {}]}, {"messages": [{"role": "system"}, {"role": "tool"}]}]
        for case in cases:
            with self.assertRaises(ValueError):
                adapter._validate(case)
        invalid = payload()
        invalid["messages"][1]["tool_calls"] = [{"function": "run"}]
        with self.assertRaises(ValueError):
            adapter._validate(invalid)

    def test_default_loopback_and_origin_only(self):
        with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": ""}):
            self.assertTrue(adapter._trusted(Request()))
            self.assertTrue(adapter._trusted(Request(host="[::1]:8188", remote="::1")))
            self.assertFalse(adapter._trusted(Request(host="evil.example:8188")))
            self.assertFalse(adapter._trusted(Request(headers={"Origin": "https://evil.example"})))
            self.assertFalse(adapter._trusted(Request(remote="203.0.113.1")))

    def test_remote_token_and_custom_gateway_header(self):
        with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "秘密", "DRAW_STUDIO_OPTIMIZER_AUTH_HEADER": "X-Optimizer-Key", "DRAW_STUDIO_OPTIMIZER_AUTH_PREFIX": ""}):
            request = Request(host="cloud.example", remote="203.0.113.1", headers={"X-Optimizer-Key": "秘密"})
            self.assertTrue(adapter._trusted(request))
            request.headers["X-Optimizer-Key"] = "wrong"
            self.assertFalse(adapter._trusted(request))

    def token_file(self, contents=b"test-only-key"):
        file = self.root / "optimizer-token"
        file.write_bytes(contents)
        file.chmod(0o600)
        return file

    def test_private_token_file_authorizes_only_matching_remote_token(self):
        file = self.token_file()
        with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "", "DRAW_STUDIO_OPTIMIZER_TOKEN_FILE": str(file), "DRAW_STUDIO_OPTIMIZER_AUTH_HEADER": "Authorization", "DRAW_STUDIO_OPTIMIZER_AUTH_PREFIX": "Bearer "}):
            request = Request(host="cloud.example", remote="203.0.113.1", headers={"Authorization": "Bearer test-only-key"})
            self.assertEqual(adapter._optimizer_token(), "test-only-key")
            self.assertTrue(adapter._trusted(request))
            request.headers["Authorization"] = "Bearer wrong"
            self.assertFalse(adapter._trusted(request))

    def test_inline_token_takes_priority_over_file(self):
        file = self.token_file()
        with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "inline-key", "DRAW_STUDIO_OPTIMIZER_TOKEN_FILE": str(file)}):
            self.assertEqual(adapter._optimizer_token(), "inline-key")
            with patch.object(adapter.os, "open", side_effect=AssertionError("File must not be opened")):
                self.assertEqual(adapter._optimizer_token(), "inline-key")

    def test_token_file_invalid_contents_fail_closed(self):
        for contents in (b"", b"\n", b"test-only-key\n", b"key\rnext", b"key\x00next", b" leading", b"\xff", b"x" * 8193):
            with self.subTest(contents_size=len(contents)):
                file = self.token_file(contents)
                with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "", "DRAW_STUDIO_OPTIMIZER_TOKEN_FILE": str(file)}):
                    self.assertEqual(adapter._optimizer_token(), "")
                    self.assertFalse(adapter._trusted(Request(host="cloud.example", remote="203.0.113.1", headers={"Authorization": "Bearer test-only-key"})))

    def test_token_file_missing_or_directory_fails_closed(self):
        for file in (self.root / "missing-token", self.root):
            with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "", "DRAW_STUDIO_OPTIMIZER_TOKEN_FILE": str(file)}):
                self.assertEqual(adapter._optimizer_token(), "")

    def test_token_file_symlink_is_rejected(self):
        file = self.token_file()
        linked = self.root / "linked-token"
        try:
            linked.symlink_to(file)
        except OSError:
            self.skipTest("Windows symlink privilege unavailable")
        with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "", "DRAW_STUDIO_OPTIMIZER_TOKEN_FILE": str(linked)}):
            self.assertEqual(adapter._optimizer_token(), "")

    @unittest.skipUnless(os.name == "posix", "POSIX ownership and modes only")
    def test_token_file_group_or_other_permissions_are_rejected(self):
        file = self.token_file()
        for mode in (0o640, 0o604, 0o620, 0o601):
            with self.subTest(mode=oct(mode)):
                file.chmod(mode)
                with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "", "DRAW_STUDIO_OPTIMIZER_TOKEN_FILE": str(file)}):
                    self.assertEqual(adapter._optimizer_token(), "")

    @unittest.skipUnless(os.name == "posix", "POSIX ownership and modes only")
    def test_token_file_different_effective_owner_is_rejected(self):
        file = self.token_file()
        with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "", "DRAW_STUDIO_OPTIMIZER_TOKEN_FILE": str(file)}), patch.object(adapter.os, "geteuid", return_value=file.stat().st_uid + 1):
            self.assertEqual(adapter._optimizer_token(), "")

    def test_token_file_replaced_before_open_is_rejected(self):
        file = self.token_file()
        opened = file.stat()
        swapped = types.SimpleNamespace(st_mode=opened.st_mode, st_size=opened.st_size, st_dev=opened.st_dev, st_ino=opened.st_ino + 1)
        with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": "", "DRAW_STUDIO_OPTIMIZER_TOKEN_FILE": str(file)}), patch.object(adapter.os, "fstat", return_value=swapped):
            self.assertEqual(adapter._optimizer_token(), "")

    def test_runtime_receives_actual_pixels_and_roles(self):
        runtime, calls, exits = self.fake_runtime()
        data = payload(True)
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            result = adapter._generate(data, threading.Event())
        self.assertIn("人物", result["choices"][0]["message"]["content"])
        completion = dict(calls)["completion"]
        self.assertEqual(completion["messages"], data["messages"])
        self.assertEqual(adapter._image_bytes(completion["messages"][1]["content"][-1]["image_url"]["url"]), adapter._image_bytes(image_url()))
        self.assertEqual(exits, ["llama", "handler"])

    def test_text_only_does_not_instantiate_vision(self):
        runtime, calls, exits = self.fake_runtime()
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            data = payload()
            data["device"] = "cpu"
            adapter._generate(data, threading.Event())
        self.assertNotIn("handler", dict(calls))
        self.assertEqual(dict(calls)["llama"]["n_gpu_layers"], 0)
        self.assertFalse(dict(calls)["format"]["enable_thinking"])
        self.assertEqual(dict(calls)["formatter"]["stop_token_ids"], [2, 3])
        self.assertEqual(dict(calls)["completion"]["messages"][1]["content"], data["messages"][1]["content"][0]["text"])
        self.assertEqual(exits, ["llama"])

    def test_real_wheel_formatter_closes_thinking_in_original_template_before_sampling(self):
        chat_format, original_template = wheel_chat_formatter()
        raw = {"id": "test", "created": 1, "model": "test.gguf", "usage": {"prompt_tokens": 100, "completion_tokens": 12, "total_tokens": 112},
               "choices": [{"text": "保留 __DRAW_MENTION_0__ 向前走。", "finish_reason": "stop", "logprobs": None}]}
        runtime, calls, exits = self.fake_runtime(completion=raw)
        runtime.llama_chat_format.Jinja2ChatFormatter = chat_format.Jinja2ChatFormatter
        runtime.llama_chat_format.chat_formatter_to_chat_completion_handler = chat_format.chat_formatter_to_chat_completion_handler
        initialize = runtime.Llama.__init__

        def init(llm, **kwargs):
            initialize(llm, **kwargs)
            llm.metadata = {"tokenizer.chat_template": original_template}
            llm.verbose = False

        def tokenize(_llm, text, add_bos, special):
            calls.append(("rendered_prompt", text.decode("utf-8")))
            calls.append(("tokenize", {"add_bos": add_bos, "special": special}))
            return [10, 11, 12]

        runtime.Llama.__init__, runtime.Llama.tokenize = init, tokenize
        data = payload()
        data["device"], data["max_tokens"], data["temperature"] = "cpu", 512, 0.15
        data["messages"][1]["content"].append({"type": "text", "text": "保持 __DRAW_MENTION_0__"})
        baseline = chat_format.Jinja2ChatFormatter(template=original_template, eos_token="<eos>", bos_token="<bos>")
        self.assertTrue(baseline(messages=adapter._text_messages(data["messages"])).prompt.endswith("<think>\n"))
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            result = adapter._generate(data, threading.Event())
        rendered, sampling = dict(calls)["rendered_prompt"], dict(calls)["sampling"]
        self.assertTrue(rendered.endswith("<|im_start|>assistant\n<think>\n\n</think>\n\n"))
        self.assertIn(data["messages"][0]["content"], rendered)
        self.assertIn("保持 __DRAW_MENTION_0__", rendered)
        self.assertEqual(sampling["max_tokens"], 512)
        self.assertEqual(sampling["temperature"], 0.15)
        self.assertEqual(sampling["stop"], ["<eos>"])
        self.assertTrue(sampling["stopping_criteria"][0]([3], []))
        self.assertFalse(sampling["stopping_criteria"][0]([4], []))
        self.assertEqual(dict(calls)["tokenize"], {"add_bos": False, "special": True})
        self.assertNotIn("handler", dict(calls))
        self.assertEqual(result["choices"][0]["message"]["content"], raw["choices"][0]["text"])
        self.assertEqual(result["usage"], raw["usage"])
        self.assertEqual(result["draw_studio_generation"], {"finishReason": "stop", "usage": raw["usage"],
                         "configuredMaxTokens": 512, "contextSize": 16384, "thinkingDisabled": True,
                         "requestedContext": 16384, "actualContext": 16384, "inputTokens": 3, "availableOutputTokens": 16381})
        self.assertEqual(exits, ["llama"])

    def test_generation_diagnostics_preserve_truncation_without_logging_content(self):
        runtime, _, _ = self.fake_runtime(completion={"choices": [{"finish_reason": "length", "message": {"content": "private output"}}],
                                                       "usage": {"prompt_tokens": 16000, "completion_tokens": 384, "total_tokens": 16384}})
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            result = adapter._generate(payload(), threading.Event())
        self.assertEqual(result["choices"][0]["finish_reason"], "length")
        self.assertEqual(result["choices"][0]["message"]["content"], "private output")
        self.assertEqual(result["draw_studio_generation"], {"finishReason": "length", "configuredMaxTokens": 4096,
                         "contextSize": 16384, "thinkingDisabled": True,
                         "requestedContext": 16384, "actualContext": 16384, "inputTokens": 18, "availableOutputTokens": 16366,
                         "usage": {"prompt_tokens": 16000, "completion_tokens": 384, "total_tokens": 16384}})
        self.assertNotIn("private", json.dumps(result["draw_studio_generation"]))
        detail = adapter._generation_diagnostics({"choices": [{"finish_reason": "untrusted detail"}],
                   "usage": {"prompt_tokens": True, "completion_tokens": -1, "total_tokens": 10 ** 1000, "detail": "private"}},
                   types.SimpleNamespace(_n_ctx=True), 4096, False)
        self.assertEqual(detail, {"finishReason": None, "configuredMaxTokens": 4096, "contextSize": None,
                                 "requestedContext": 16384, "actualContext": None, "inputTokens": None, "availableOutputTokens": None,
                                 "thinkingDisabled": False, "usage": {}})

    def test_other_gguf_templates_keep_the_native_handler(self):
        runtime, calls, _ = self.fake_runtime()
        initialize = runtime.Llama.__init__

        def init(llm, **kwargs):
            initialize(llm, **kwargs)
            # Mentioning the variable only in a literal must not replace a
            # model's native formatter, either.
            llm.metadata = {"tokenizer.chat_template": "literal enable_thinking {{ messages[0].content }}"}

        runtime.Llama.__init__ = init
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            adapter._generate(payload(), threading.Event())
        self.assertNotIn("formatter", dict(calls))
        self.assertIsNone(runtime.last_llm.chat_handler)

    def test_named_original_template_is_preserved(self):
        runtime, calls, _ = self.fake_runtime()
        initialize = runtime.Llama.__init__
        template = "named {% if enable_thinking %}thinking{% else %}answer{% endif %}"

        def init(llm, **kwargs):
            initialize(llm, **kwargs)
            llm.chat_format = "chat_template.selected"
            llm.metadata["tokenizer.chat_template.selected"] = template

        runtime.Llama.__init__ = init
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            adapter._generate(payload(), threading.Event())
        self.assertEqual(dict(calls)["formatter"]["template"], template)
        self.assertFalse(dict(calls)["format"]["enable_thinking"])

    def test_text_formatter_failure_closes_model_and_releases_capacity(self):
        runtime, calls, exits = self.fake_runtime()
        runtime.llama_chat_format.Jinja2ChatFormatter = None
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "模板格式化接口"):
                adapter._generate(payload(), threading.Event())
        self.assertEqual(exits, ["llama"])
        self.assertNotIn("handler", dict(calls))
        self.assertFalse(adapter._LOCK.locked())

    def test_temperature_and_output_budget_are_forwarded_for_text_and_images(self):
        for images in (False, True):
            runtime, calls, _ = self.fake_runtime()
            data = payload(images)
            data["temperature"], data["max_tokens"] = 0.15, 4096
            with patch.dict(sys.modules, {"llama_cpp": runtime}):
                adapter._generate(data, threading.Event())
            self.assertEqual(dict(calls)["completion"]["temperature"], 0.15)
            self.assertEqual(dict(calls)["sampling"]["max_tokens"], 4096)
            if images:
                self.assertNotIn("formatter", dict(calls))
                self.assertFalse(dict(calls)["handler"]["enable_thinking"])
                self.assertEqual(dict(calls)["completion"]["messages"], data["messages"])
        for value in (True, -0.1, 2.1, 10 ** 1000, float("nan"), float("inf"), "0.15"):
            with self.subTest(temperature=repr(value)):
                data = payload()
                data["temperature"] = value
                with self.assertRaisesRegex(ValueError, "采样温度"):
                    adapter._validate(data)

    def test_context_settings_are_bounded_and_output_must_leave_input_space(self):
        for value in (True, 2047, 100001, 16384.0, "100000"):
            data = payload()
            data["context_tokens"] = value
            with self.subTest(context=value), self.assertRaisesRegex(ValueError, "总上下文"):
                adapter._validate(data)
        for context, output in ((2048, 2048), (2048, 4096), (10000, 10000)):
            data = payload()
            data["context_tokens"], data["max_tokens"] = context, output
            with self.subTest(context=context, output=output), self.assertRaisesRegex(ValueError, "必须小于"):
                adapter._validate(data)

    def test_100000_total_context_and_10000_output_are_used_without_forcing_length(self):
        runtime, calls, exits = self.fake_runtime()
        data = payload()
        data["context_tokens"], data["max_tokens"] = 100000, 10000
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            result = adapter._generate(data, threading.Event())
        self.assertEqual(dict(calls)["llama"]["n_ctx"], 100000)
        self.assertEqual(dict(calls)["sampling"]["max_tokens"], 10000)
        self.assertEqual(result["choices"][0]["finish_reason"], "stop")
        self.assertEqual(result["draw_studio_generation"]["requestedContext"], 100000)
        self.assertEqual(result["draw_studio_generation"]["actualContext"], 100000)
        self.assertEqual(result["draw_studio_generation"]["availableOutputTokens"], 99982)
        self.assertEqual(exits, ["llama"])

    def test_native_padding_does_not_expand_the_users_total_context_budget(self):
        for images in (False, True):
            for input_size, should_pass in ((90000, True), (90001, False)):
                runtime, calls, exits = self.fake_runtime()
                runtime.Llama.n_ctx = lambda _: 100096
                runtime.Llama.tokenize = lambda _llm, _text, add_bos=False, special=True: [4] * input_size
                runtime.media_tokens = input_size
                data = payload(images)
                data["context_tokens"], data["max_tokens"] = 100000, 10000
                with self.subTest(images=images, input_tokens=input_size), patch.dict(sys.modules, {"llama_cpp": runtime}):
                    if should_pass:
                        result = adapter._generate(data, threading.Event())
                        detail = result["draw_studio_generation"]
                        self.assertEqual(detail["requestedContext"], 100000)
                        self.assertEqual(detail["actualContext"], 100096)
                        self.assertEqual(detail["inputTokens"], 90000)
                        self.assertEqual(detail["availableOutputTokens"], 10000)
                        self.assertEqual(dict(calls)["sampling"]["max_tokens"], 10000)
                    else:
                        with self.assertRaisesRegex(ValueError, "超过总上下文 100000"):
                            adapter._generate(data, threading.Event())
                        self.assertNotIn("sampling", dict(calls))
                        if images:
                            self.assertNotIn("media_eval", dict(calls))
                            self.assertEqual(len([1 for key, _ in calls if key == "media_free"]), 1)
                self.assertEqual(exits, ["llama", "handler"] if images else ["llama"])

    def test_context_metadata_is_read_and_checked_before_model_loading(self):
        gguf(self.llm / "test.gguf", "qwen35", [("qwen35.context_length", 4, struct.pack("<I", 8192))])
        models, _, _ = adapter._inventory()
        self.assertEqual(models["test.gguf"]["metadata"]["qwen35.context_length"], 8192)
        runtime, calls, exits = self.fake_runtime()
        data = payload()
        data["context_tokens"] = 100000
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "超过模型训练窗口 8192"):
                adapter._generate(data, threading.Event())
        self.assertEqual(calls, [])
        self.assertEqual(exits, [])

    def test_native_training_context_is_checked_when_metadata_does_not_publish_it(self):
        runtime, calls, exits = self.fake_runtime()
        runtime.Llama.n_ctx_train = lambda _: 8192
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "超过模型训练窗口 8192"):
                adapter._generate(payload(), threading.Event())
        self.assertNotIn("sampling", dict(calls))
        self.assertEqual(exits, ["llama"])

    def test_text_budget_checks_real_tokens_before_sampling_without_silent_shrink(self):
        for input_size, should_pass in ((1536, True), (1537, False)):
            runtime, calls, exits = self.fake_runtime()
            runtime.Llama.tokenize = lambda _llm, _text, add_bos=False, special=True: [4] * input_size
            data = payload()
            data["context_tokens"], data["max_tokens"] = 2048, 512
            with self.subTest(input_size=input_size), patch.dict(sys.modules, {"llama_cpp": runtime}):
                if should_pass:
                    result = adapter._generate(data, threading.Event())
                    self.assertEqual(dict(calls)["sampling"]["max_tokens"], 512)
                    self.assertEqual(result["draw_studio_generation"]["inputTokens"], 1536)
                    self.assertEqual(result["draw_studio_generation"]["availableOutputTokens"], 512)
                else:
                    with self.assertRaisesRegex(ValueError, "输入占用 1537 token"):
                        adapter._generate(data, threading.Event())
                    self.assertNotIn("sampling", dict(calls))
            self.assertEqual(exits, ["llama"])

    def test_text_budget_normalization_preserves_native_bos_eos_and_sep_policy(self):
        options = []
        model = types.SimpleNamespace(get_add_bos=lambda: True, get_add_eos=lambda: True, get_add_sep=lambda: False)
        llm = types.SimpleNamespace(_model=model, token_bos=lambda: 1, token_eos=lambda: 2, token_sep=lambda: 3,
                                    tokenize=lambda text, **kwargs: options.append((text, kwargs)) or [10, 11])
        self.assertEqual(adapter._completion_prompt_tokens(llm, "text"), [1, 10, 11, 2])
        self.assertEqual(options, [(b"text", {"add_bos": False, "special": True})])
        model.get_add_sep = lambda: True
        self.assertEqual(adapter._completion_prompt_tokens(llm, "text"), [1, 10, 11, 3])
        encoded = [1, 10, 11, 3]
        self.assertIs(adapter._completion_prompt_tokens(llm, encoded), encoded)

    def test_actual_wheel_mtmd_sequence_checks_visual_ledger_before_eval_and_frees_on_rejection(self):
        chat_format, _ = wheel_chat_formatter()
        runtime, calls, exits = self.fake_runtime()
        runtime.media_tokens = 1537
        # Execute the original installed MTMD __call__ entry sequence. Our
        # override must reject at ledger return, before it accesses eval/shift.
        runtime.llama_chat_format.Qwen35ChatHandler.__call__ = chat_format.mtmd_chat_handler_call
        data = payload(True)
        data["context_tokens"], data["max_tokens"] = 2048, 512
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "输入占用 1537 token"):
                adapter._generate(data, threading.Event())
        self.assertNotIn("sampling", dict(calls))
        self.assertNotIn("media_eval", dict(calls))
        self.assertEqual([value for key, value in calls if key == "media_free"], [{"chunks": "owned-chunks", "bitmaps": ["owned-bitmap"]}])
        self.assertEqual(exits, ["llama", "handler"])

    def test_visual_ledger_cancel_before_eval_frees_media_and_releases_capacity(self):
        runtime, calls, exits = self.fake_runtime()
        cancel = threading.Event()
        prepare = runtime.llama_chat_format.Qwen35ChatHandler._process_mtmd_prompt

        def prepared(handler, *args, **kwargs):
            result = prepare(handler, *args, **kwargs)
            cancel.set()
            return result

        runtime.llama_chat_format.Qwen35ChatHandler._process_mtmd_prompt = prepared
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(RuntimeError, "取消"):
                adapter._generate(payload(True), cancel)
        self.assertNotIn("sampling", dict(calls))
        self.assertNotIn("media_eval", dict(calls))
        self.assertEqual(len([1 for key, _ in calls if key == "media_free"]), 1)
        self.assertEqual(exits, ["llama", "handler"])

    def test_visual_handler_without_ledger_hook_fails_before_loading(self):
        runtime, calls, exits = self.fake_runtime()
        runtime.llama_chat_format.Qwen35ChatHandler._process_mtmd_prompt = None
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "实际图像 token"):
                adapter._generate(payload(True), threading.Event())
        self.assertNotIn("llama", dict(calls))
        self.assertNotIn("handler", dict(calls))
        self.assertEqual(exits, [])

    def test_actual_context_cannot_silently_shrink_the_requested_window(self):
        runtime, calls, exits = self.fake_runtime()
        runtime.Llama.n_ctx = lambda _: 8192
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "未能提供所选总上下文"):
                adapter._generate(payload(), threading.Event())
        self.assertNotIn("sampling", dict(calls))
        self.assertEqual(exits, ["llama"])

    def test_cuda_request_never_silently_runs_cpu_inference(self):
        runtime, calls, exits = self.fake_runtime()
        runtime.llama_supports_gpu_offload = lambda: False
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "CUDA 后端未成功加载"):
                adapter._generate(payload(True), threading.Event())
        self.assertNotIn("completion", dict(calls))
        self.assertEqual(exits, [])

    def test_cuda_preflight_loads_dynamic_plugins_before_model_and_only_once(self):
        runtime, calls, _ = self.fake_runtime()
        runtime.__file__ = str(self.root / "runtime" / "__init__.py")
        lib_dir = self.root / "runtime" / "lib"
        lib_dir.mkdir(parents=True)
        loaded = []
        runtime.llama_backend_init = lambda: loaded.append("init")
        runtime.ggml_backend_load_all_from_path = lambda path: loaded.append(path)
        runtime.llama_supports_gpu_offload = lambda: len(loaded) == 2
        runtime.ggml_backend_reg_by_name = lambda name: name == b"CUDA" and len(loaded) == 2
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            adapter._generate(payload(), threading.Event())
            adapter._generate(payload(), threading.Event())
        self.assertEqual(loaded, ["init", str(lib_dir.resolve()).encode("utf-8")])
        self.assertEqual(len([call for call in calls if call[0] == "completion"]), 2)

    def test_rpc_support_does_not_imply_cuda_is_available(self):
        runtime, calls, _ = self.fake_runtime()
        runtime.ggml_backend_reg_by_name = lambda _name: None
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "CUDA 后端未成功加载"):
                adapter._generate(payload(), threading.Event())
        self.assertFalse(calls)

    def test_cpu_visual_keeps_both_model_and_projector_off_gpu(self):
        runtime, calls, _ = self.fake_runtime()
        data = payload(True)
        data["device"] = "cpu"
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            adapter._generate(data, threading.Event())
        self.assertEqual(dict(calls)["llama"]["n_gpu_layers"], 0)
        self.assertFalse(dict(calls)["handler"]["use_gpu"])

    def test_cpu_visual_fails_before_loading_when_handler_cannot_disable_gpu(self):
        runtime, calls, _ = self.fake_runtime()

        class LegacyHandler:
            def __init__(self, clip_model_path, verbose=False):
                calls.append(("legacy-handler", {"clip_model_path": clip_model_path, "verbose": verbose}))

        runtime.llama_chat_format.Qwen35ChatHandler = LegacyHandler
        data = payload(True)
        data["device"] = "cpu"
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            with self.assertRaisesRegex(ValueError, "CPU"):
                adapter._generate(data, threading.Event())
        self.assertNotIn("llama", dict(calls))

    def test_real_model_and_projector_required(self):
        runtime, _, _ = self.fake_runtime()
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            missing = payload()
            missing["model"] = "../outside.gguf"
            with self.assertRaisesRegex(ValueError, "不在"):
                adapter._generate(missing, threading.Event())
            missing = payload(True)
            missing["mmproj"] = ""
            with self.assertRaisesRegex(ValueError, "mmproj"):
                adapter._generate(missing, threading.Event())
            gguf(self.llm / "unrelated-mmproj.gguf", "clip", [("general.name", 8, "Qwen3.5-7B")])
            missing = payload(True)
            missing["mmproj"] = "unrelated-mmproj.gguf"
            with self.assertRaisesRegex(ValueError, "兼容"):
                adapter._generate(missing, threading.Event())

    def test_failure_and_close_failure_always_release_lock(self):
        for close_error, generate_error in [(False, True), (True, False)]:
            runtime, _, exits = self.fake_runtime(close_error=close_error, generate_error=generate_error)
            with patch.dict(sys.modules, {"llama_cpp": runtime}):
                with self.assertRaises(RuntimeError):
                    adapter._generate(payload(True), threading.Event())
            self.assertFalse(adapter._LOCK.locked())
            self.assertEqual(exits, ["llama", "handler"])

    def test_concurrent_inference_and_cancel(self):
        adapter._LOCK.acquire()
        try:
            with self.assertRaisesRegex(RuntimeError, "另一项"):
                adapter._generate(payload(), threading.Event())
        finally:
            adapter._LOCK.release()
        cancel = threading.Event()
        cancel.set()
        with self.assertRaisesRegex(RuntimeError, "取消"):
            adapter._generate(payload(), cancel)

    def test_cancellation_during_sampling_closes_runtime_and_releases_lock(self):
        for with_images in (False, True):
            with self.subTest(images=with_images):
                cancel = threading.Event()
                runtime, calls, exits = self.fake_runtime(on_sample=cancel.set)
                with patch.dict(sys.modules, {"llama_cpp": runtime}):
                    with self.assertRaisesRegex(RuntimeError, "取消"):
                        adapter._generate(payload(with_images), cancel)
                self.assertEqual(exits, ["llama", "handler"] if with_images else ["llama"])
                self.assertTrue(dict(calls)["stopped"])
                self.assertFalse(adapter._LOCK.locked())

    def test_handler_stopping_criteria_are_preserved(self):
        runtime, calls, exits = self.fake_runtime()
        checked = []

        def stop(_input_ids, _scores):
            checked.append(True)
            return True

        def chat(llm, messages, max_tokens=None, temperature=0.2):
            return llm.create_completion(prompt="formatted messages", stopping_criteria=[stop])

        runtime.Llama.create_chat_completion = chat
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            adapter._generate(payload(), threading.Event())
        self.assertEqual(checked, [True])
        self.assertTrue(dict(calls)["stopped"])
        self.assertEqual(exits, ["llama"])

    def test_models_route_reports_runtime_and_projectors(self):
        runtime, _, _ = self.fake_runtime()
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            response = asyncio.run(adapter.models_route(Request()))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body["models"][0]["capability"], "vision")
        self.assertEqual(response.body["models"][0]["mmprojCandidates"], ["mmproj.gguf"])
        self.assertEqual(response.body["models"][0]["mmprojCandidateDetails"], [{"id": "mmproj.gguf", "match": "metadata-exact", "confidence": "high"}])
        self.assertEqual(response.body["models"][0]["recommendedMmproj"], "mmproj.gguf")
        self.assertEqual(response.body["mmprojModels"], ["mmproj.gguf"])

    def test_cold_runtime_import_does_not_block_status_requests(self):
        started, release = threading.Event(), threading.Event()
        runtime, _, _ = self.fake_runtime()

        def dependency():
            started.set()
            if not release.wait(2):
                raise AssertionError("Model discovery blocked the HTTP event loop")
            return {"available": True, "version": "test-double"}

        async def scenario():
            task = asyncio.create_task(adapter.models_route(Request()))
            try:
                for _ in range(200):
                    if started.is_set():
                        break
                    await asyncio.sleep(0.001)
                self.assertTrue(started.is_set())
                response = await adapter.status_route(Request(query={"request_id": "not-running"}))
                self.assertEqual(response.status, 404)
                release.set()
                self.assertEqual((await task).status, 200)
            finally:
                release.set()
                await task

        with patch.dict(sys.modules, {"llama_cpp": runtime}), patch.object(adapter, "_dependency", dependency):
            asyncio.run(scenario())

    def test_known_handler_without_compatible_projector_is_not_labeled_vision(self):
        (self.llm / "mmproj.gguf").unlink()
        gguf(self.llm / "other-projector.gguf", "clip", [("general.name", 8, "Qwen3.5-7B")])
        runtime, _, _ = self.fake_runtime()
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            response = asyncio.run(adapter.models_route(Request()))
        model = response.body["models"][0]
        self.assertEqual(model["capability"], "unknown")
        self.assertEqual(model["mmprojCandidates"], [])
        self.assertEqual(model["mmprojCandidateDetails"], [])
        self.assertIsNone(model["recommendedMmproj"])

    def test_route_body_bounds_and_cancel_are_local(self):
        response = asyncio.run(adapter.cancel_route(Request(body=b" " * 5000)))
        self.assertEqual(response.status, 400)
        event = threading.Event()
        adapter._CANCEL["ours"] = event
        response = asyncio.run(adapter.cancel_route(Request({"request_id": "ours"})))
        self.assertTrue(response.body["cancelled"])
        self.assertTrue(event.is_set())
        response = asyncio.run(adapter.cancel_route(Request({"request_id": "other"})))
        self.assertFalse(response.body["cancelled"])

    def test_duplicate_request_does_not_drop_active_cancel_event(self):
        event = threading.Event()
        adapter._CANCEL["unique"] = event
        response = asyncio.run(adapter.optimize_route(Request(payload())))
        self.assertEqual(response.status, 400)
        self.assertIs(adapter._CANCEL["unique"], event)

    def test_real_transport_disconnect_cancels_own_event(self):
        data = payload()
        request = Request(data)
        request.transport = None

        def wait_for_cancel(_, cancel):
            if not cancel.wait(2):
                raise RuntimeError("Cancellation not delivered")
            raise RuntimeError("优化已取消。")

        with patch.object(adapter, "_generate", wait_for_cancel):
            response = asyncio.run(adapter.optimize_route(request))
        self.assertEqual(response.status, 400)
        self.assertIn("取消", response.body["error"])
        self.assertNotIn("unique", adapter._CANCEL)

    def test_async_start_and_poll_cycle_returns_completion(self):
        runtime, _, _ = self.fake_runtime()

        async def cycle():
            response = await adapter.start_route(Request(payload()))
            self.assertEqual(response.status, 202)
            self.assertEqual(response.body, {"request_id": "unique", "status": "running"})
            status_request = Request(query={"request_id": "unique"})
            first = await adapter.status_route(status_request)
            self.assertEqual(first.body["status"], "running")
            await adapter._JOBS["unique"]["task"]
            last = await adapter.status_route(status_request)
            self.assertEqual(last.body["status"], "success")
            self.assertIn("人物", last.body["result"]["choices"][0]["message"]["content"])
            self.assertNotIn("unique", adapter._CANCEL)

        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            asyncio.run(cycle())

    def test_async_explicit_cancel_keeps_capacity_until_worker_exits(self):
        started, release = threading.Event(), threading.Event()

        def blocked(_, cancel):
            started.set()
            if not release.wait(2):
                raise RuntimeError("test worker release missing")
            raise RuntimeError("优化已取消。")

        async def cycle():
            await adapter.start_route(Request(payload()))
            task = adapter._JOBS["unique"]["task"]
            await adapter._in_thread(started.wait, 1)
            event = adapter._CANCEL["unique"]
            response = await adapter.cancel_route(Request({"request_id": "unique"}))
            self.assertTrue(response.body["cancelled"])
            self.assertTrue(event.is_set())
            self.assertIs(adapter._CANCEL["unique"], event)
            self.assertEqual((await adapter.status_route(Request(query={"request_id": "unique"}))).body["status"], "running")
            other = payload()
            other["request_id"] = "other"
            self.assertEqual((await adapter.start_route(Request(other))).status, 409)
            release.set()
            await task
            self.assertEqual((await adapter.status_route(Request(query={"request_id": "unique"}))).body["status"], "cancelled")
            self.assertNotIn("unique", adapter._CANCEL)

        with patch.object(adapter, "_generate", blocked):
            asyncio.run(cycle())

    def test_async_http_disconnect_does_not_cancel_background_job(self):
        runtime, _, _ = self.fake_runtime()

        async def cycle():
            request = Request(payload())
            request.transport = None
            response = await adapter.start_route(request)
            self.assertEqual(response.status, 202)
            event = adapter._CANCEL["unique"]
            await adapter._JOBS["unique"]["task"]
            self.assertFalse(event.is_set())
            status = await adapter.status_route(Request(query={"request_id": "unique"}))
            self.assertEqual(status.body["status"], "success")

        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            asyncio.run(cycle())

    def test_async_errors_keep_specific_failure(self):
        def failed(*_):
            raise ValueError("controlled missing projector")

        async def cycle():
            await adapter.start_route(Request(payload()))
            await adapter._JOBS["unique"]["task"]
            response = await adapter.status_route(Request(query={"request_id": "unique"}))
            self.assertEqual(response.body["status"], "error")
            self.assertEqual(response.body["error"], "controlled missing projector")

        with patch.object(adapter, "_generate", failed):
            asyncio.run(cycle())

    def test_async_routes_require_auth_and_validate_ids(self):
        async def checks():
            remote = Request(payload(), host="cloud.example", remote="203.0.113.1")
            self.assertEqual((await adapter.start_route(remote)).status, 403)
            self.assertEqual((await adapter.status_route(remote)).status, 403)
            self.assertEqual((await adapter.status_route(Request(query={"request_id": "not-found"}))).status, 404)
            invalid = payload()
            invalid["request_id"] = {"arbitrary": "object"}
            self.assertEqual((await adapter.start_route(Request(invalid))).status, 400)
            invalid = payload()
            invalid["messages"][1]["content"] = ["bad part"]
            self.assertEqual((await adapter.start_route(Request(invalid))).status, 400)
            self.assertEqual((await adapter.status_route(Request(query={"request_id": " "}))).status, 400)
            self.assertEqual((await adapter.cancel_route(Request({"request_id": {"not": "a string"}}))).status, 400)
        with patch.dict(os.environ, {"DRAW_STUDIO_OPTIMIZER_TOKEN": ""}):
            asyncio.run(checks())

    def test_finished_job_history_is_bounded_and_expired(self):
        adapter._JOBS["expired"] = {"request_id": "expired", "status": "success", "finished": 0, "result": {}}
        with patch.object(adapter.time, "monotonic", return_value=adapter._JOB_TTL + 1):
            adapter._prune_jobs()
        self.assertNotIn("expired", adapter._JOBS)
        for index in range(adapter._MAX_JOBS):
            key = str(index)
            adapter._JOBS[key] = {"request_id": key, "status": "success", "finished": index + 1, "result": {}}
        with patch.object(adapter.time, "monotonic", return_value=100):
            adapter._prune_jobs(make_room=True)
        self.assertEqual(len(adapter._JOBS), adapter._MAX_JOBS - 1)
        self.assertNotIn("0", adapter._JOBS)

    def test_direct_http_cancel_does_not_remove_native_worker_capacity(self):
        started, release = threading.Event(), threading.Event()

        def blocked(_, cancel):
            started.set()
            release.wait(2)
            raise RuntimeError("优化已取消。")

        async def cycle():
            direct = asyncio.create_task(adapter.optimize_route(Request(payload())))
            await adapter._in_thread(started.wait, 1)
            worker = adapter._JOBS["unique"]["task"]
            event = adapter._CANCEL["unique"]
            direct.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await direct
            self.assertTrue(event.is_set())
            self.assertIs(adapter._CANCEL["unique"], event)
            release.set()
            await worker
            self.assertNotIn("unique", adapter._CANCEL)

        with patch.object(adapter, "_generate", blocked):
            asyncio.run(cycle())

    def test_prompt_output_validation(self):
        def result(content, reason="stop"):
            return {"choices": [{"finish_reason": reason, "message": {"content": content}}]}
        self.assertEqual(adapter._node_result(result("<think>hidden</think>\n```text\n保持 __DRAW_MENTION_0__\n```"), "用 __DRAW_MENTION_0__"), "保持 __DRAW_MENTION_0__")
        for value in [result(""), result("partial", "length"), result("<think>unclosed"), result("drops reference")]:
            with self.assertRaises(ValueError):
                adapter._node_result(value, "__DRAW_MENTION_0__")

    def test_standalone_node_text_and_real_tensor_pixels(self):
        import numpy as np

        class Tensor:
            def __init__(self, array):
                self.array, self.shape = array, array.shape

            def __iter__(self):
                return iter(Tensor(row) for row in self.array)

            def detach(self):
                return self

            cpu = detach

            def numpy(self):
                return self.array

        runtime, calls, _ = self.fake_runtime()
        images = Tensor(np.ones((2, 4, 5, 3), dtype=np.float32) * 0.25)
        with patch.dict(sys.modules, {"llama_cpp": runtime}):
            result = adapter.DrawStudioPromptOptimizer().optimize("人物向前走", "test.gguf", "中文", "cuda", "保留服装", images, "mmproj.gguf", '[{"role":"firstFrame","label":"首帧"},{"role":"lastFrame","label":"尾帧"}]', '{"kind":"video","mode":"first-last-frame"}', max_tokens=512)
        self.assertIn("人物", result["result"][0])
        completion = dict(calls)["completion"]
        self.assertEqual(completion["max_tokens"], 512)
        parts = completion["messages"][1]["content"]
        self.assertEqual(len([p for p in parts if p["type"] == "image_url"]), 2)
        self.assertIn("firstFrame", parts[1]["text"])
        self.assertIn("lastFrame", parts[3]["text"])
        for part in parts:
            if part["type"] == "image_url":
                self.assertTrue(adapter._image_bytes(part["image_url"]["url"]))

    def test_node_present_and_workflow_has_no_generation(self):
        self.assertIn("DrawStudioPromptOptimizer", adapter.NODE_CLASS_MAPPINGS)
        self.assertEqual(adapter.DrawStudioPromptOptimizer.RETURN_TYPES, ("STRING",))
        node_inputs = adapter.DrawStudioPromptOptimizer.INPUT_TYPES()
        self.assertEqual(list(node_inputs["required"])[-2:], ["max_tokens", "context_tokens"])
        self.assertEqual(list(node_inputs["optional"]), ["images"])
        max_tokens = node_inputs["required"]["max_tokens"][1]
        self.assertEqual(max_tokens, {"default": 4096, "min": 512, "max": 10000, "step": 1})
        self.assertEqual(node_inputs["required"]["context_tokens"][1], {"default": 16384, "min": 2048, "max": 100000, "step": 512})
        workflow = json.loads((location.parent.parent / "Draw studio - AI 提示词优化工作流.json").read_text(encoding="utf-8"))
        self.assertEqual([node["type"] for node in workflow["nodes"]], ["DrawStudioPromptOptimizer"])
        self.assertFalse(workflow["links"])
        values = workflow["nodes"][0]["widgets_values"]
        self.assertEqual(values[1], "Qwen3.8-27B-UD-Q2_K_XL.gguf")
        self.assertEqual(values[5], "mmproj-Qwen3.8-27B-F16.gguf")
        self.assertTrue(json.loads(values[-2])["readMedia"])
        self.assertEqual(values[-1], 4096)


if __name__ == "__main__":
    unittest.main()
