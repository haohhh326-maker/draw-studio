// Headless NDJSON host for the unmodified official FileZilla CFileZillaEngine.
// Only this integration layer is Draw Studio code. SSH, directory enumeration,
// asynchronous disk reads, SFTP upload scheduling and rename use upstream code.
// Distributed with the upstream FileZilla license and notices in vendor/.
#include <libfilezilla_engine.h>
#include <engine_context.h>
#include <engine_options.h>
#include <optionsbase.h>
#include <version.h>
#include <fzssh/pubkey.hpp>
#include <fzssh/version.hpp>
#include <libfilezilla/encode.hpp>
#include <libfilezilla/hash.hpp>
#include <libfilezilla/string.hpp>
#include <libfilezilla/util.hpp>
#include <libfilezilla/version.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <clocale>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fcntl.h>
#include <iostream>
#include <linux/memfd.h>
#include <linux/openat2.h>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <thread>
#include <unistd.h>

using json = nlohmann::json;

namespace {
std::mutex output_mutex;
void emit(json const& value) {
  std::lock_guard lock(output_mutex);
  std::cout << value.dump(-1, ' ', false, json::error_handler_t::replace) << '\n' << std::flush;
}
void result(std::string const& id, json const& value) { emit({{"id", id}, {"ok", true}, {"result", value}}); }
void error(std::string const& id, std::string const& code, std::string const& message, json details = json::object()) {
  details["code"] = code; details["message"] = message;
  emit({{"id", id}, {"ok", false}, {"error", std::move(details)}});
}
bool clean(std::string const& value) {
  return std::none_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; });
}
std::string lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}
std::string absolute_remote(json const& request, char const* key = "path") {
  auto value = request.at(key).get<std::string>();
  if (value.empty() || value.front() != '/' || value.size() > 4096 || !clean(value) || value.find('\\') != std::string::npos)
    throw std::invalid_argument("invalid remote path");
  value = std::filesystem::path(value).lexically_normal().generic_string();
  while (value.size() > 1 && value.back() == '/') value.pop_back();
  return value;
}
struct disconnected_notification final {
  bool send{};
  ~disconnected_notification() { if (send) emit({{"event", "disconnected"}}); }
};
CServerPath server_path(std::string const& path) {
  CServerPath result(fz::to_wstring_from_utf8(path), UNIX);
  if (result.empty()) throw std::invalid_argument("invalid server path");
  return result;
}
json entry_attributes(CDirentry const& entry) {
  json value{{"directory", entry.is_dir()}, {"symlink", entry.is_link()}, {"size", std::max<int64_t>(0, entry.size)}};
  if (!entry.time.empty()) value["modified"] = static_cast<int64_t>(entry.time.get_time_t()) * 1000 + entry.time.get_milliseconds();
  return value;
}

// All settings are fixed before constructing the engine context. No runtime
// option writes are made, so notification dispatch is deliberately unnecessary.
// COptionsBase calls notify_changed with its write lock held: never reenter it.
class fixed_options final : public COptionsBase {
public:
  fixed_options() {
    set(OPTION_TIMEOUT, 0);
    set(OPTION_RECONNECTCOUNT, 0);
    set(OPTION_RECONNECTDELAY, 0);
    set(OPTION_SPEEDLIMIT_ENABLE, 0);
    set(OPTION_FTP_SENDKEEPALIVE, 0);
    set(OPTION_PRESERVE_TIMESTAMPS, 0);
    set(OPTION_LOGGING_DEBUGLEVEL, 0);
    set(OPTION_LOGGING_RAWLISTING, 0);
    set(OPTION_LOGGING_FILE, std::wstring_view{});
    set(OPTION_PROXY_TYPE, 0);
  }
private:
  void notify_changed() override {}
};
class utf8_converter final : public CustomEncodingConverterBase {
public:
  std::wstring toLocal(std::wstring const&, char const* value, size_t length) const override {
    return fz::to_wstring_from_utf8(std::string_view(value, length));
  }
  std::string toServer(std::wstring const&, wchar_t const* value, size_t length) const override {
    return fz::to_utf8(std::wstring_view(value, length));
  }
};

// Keep the validated descriptor open for the entire upload. Factories clone
// ownership of this descriptor, never a pathname that could be swapped later.
struct confined_source final {
  int fd{-1};
  struct stat identity{};
  std::wstring name;
  ~confined_source() { if (fd >= 0) ::close(fd); }
  bool unchanged() const {
    struct stat current{};
    return fd >= 0 && !::fstat(fd, &current) && S_ISREG(current.st_mode) &&
      current.st_dev == identity.st_dev && current.st_ino == identity.st_ino &&
      current.st_size == identity.st_size && current.st_mtim.tv_sec == identity.st_mtim.tv_sec &&
      current.st_mtim.tv_nsec == identity.st_mtim.tv_nsec;
  }
};
std::shared_ptr<confined_source> open_confined_source(json const& request) {
  auto filename = request.at("localPath").get<std::string>();
  auto allowed = request.at("allowedRoot").get<std::string>();
  if (filename.empty() || filename.front() != '/' || filename.size() > 4096 || !clean(filename) ||
      allowed.empty() || allowed.front() != '/' || allowed.size() > 4096 || !clean(allowed))
    throw std::invalid_argument("invalid local path");
  auto root = std::filesystem::canonical(allowed);
  if (root != std::filesystem::path(allowed).lexically_normal() || !std::filesystem::is_directory(root))
    throw std::invalid_argument("local root changed");
  auto canonical = std::filesystem::canonical(filename);
  auto relative = canonical.lexically_relative(root);
  if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
    throw std::invalid_argument("outside local root");
  struct stat before{};
  if (::stat(canonical.c_str(), &before) || !S_ISREG(before.st_mode)) throw std::invalid_argument("invalid local file");
  int root_fd = ::open(root.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) throw std::invalid_argument("invalid local root");
  int fd = -1;
  try {
    if (std::filesystem::canonical("/proc/self/fd/" + std::to_string(root_fd)) != root)
      throw std::invalid_argument("local root changed");
    open_how how{};
    how.flags = O_RDONLY | O_CLOEXEC;
    how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS;
    fd = static_cast<int>(::syscall(SYS_openat2, root_fd, relative.c_str(), &how, sizeof(how)));
  } catch (...) { ::close(root_fd); throw; }
  ::close(root_fd);
  auto source = std::make_shared<confined_source>(); source->fd = fd;
  if (fd < 0 || ::fstat(fd, &source->identity) || !S_ISREG(source->identity.st_mode) ||
      before.st_dev != source->identity.st_dev || before.st_ino != source->identity.st_ino)
    throw std::invalid_argument("local file changed");
  if (request.contains("expectedIdentity")) {
    auto const& expected = request.at("expectedIdentity");
    double modified = static_cast<double>(source->identity.st_mtim.tv_sec) * 1000 +
      static_cast<double>(source->identity.st_mtim.tv_nsec) / 1000000;
    if (expected.at("size").get<uint64_t>() != static_cast<uint64_t>(source->identity.st_size) ||
        std::abs(expected.at("mtimeMs").get<double>() - modified) > 2)
      throw std::invalid_argument("local file changed");
  }
  source->name = fz::to_wstring_from_utf8(canonical.filename().string());
  return source;
}
class descriptor_reader_factory final : public fz::reader_factory {
public:
  descriptor_reader_factory(std::shared_ptr<confined_source> source, fz::thread_pool& pool)
    : fz::reader_factory(source->name), source_(std::move(source)), pool_(pool) {}
  std::unique_ptr<fz::reader_factory> clone() const override {
    return std::make_unique<descriptor_reader_factory>(source_, pool_);
  }
  std::unique_ptr<fz::reader_base> open(fz::aio_buffer_pool& buffers, uint64_t offset, uint64_t size, size_t count) override {
    if (!source_->unchanged()) return {};
    int fd = ::fcntl(source_->fd, F_DUPFD_CLOEXEC, 0);
    if (fd < 0) return {};
    fz::file file(fd);
    return std::make_unique<fz::file_reader>(name_, buffers, std::move(file), pool_, offset, size, count);
  }
  bool seekable() const override { return true; }
  uint64_t size() const override { return static_cast<uint64_t>(source_->identity.st_size); }
  fz::datetime mtime() const override { return fz::datetime(source_->identity.st_mtim.tv_sec, fz::datetime::seconds); }
  bool multiple_buffer_usage() const override { return true; }
  size_t preferred_buffer_count() const override { return 4; }
private:
  std::shared_ptr<confined_source> source_;
  fz::thread_pool& pool_;
};

enum class phase { none, connecting, home, listing, stat_parent, stat_link, mkdir_parent, mkdir_create,
  upload_parent, uploading, committing, cleanup, disconnecting };
struct request_state final {
  json request;
  std::string id, type, remote, parent, filename, temporary;
  phase stage{phase::none};
  CDirectoryListing listing;
  std::optional<CDirentry> link;
  std::shared_ptr<confined_source> source;
  bool cancelled{}, cancel_dispatched{}, owns_temporary{}, temporary_collision{};
  uint64_t bytes{};
  std::string failure_code, failure_message;
};

class bridge final {
public:
  bridge() : context_(options_, converter_), engine_(context_, [this](CFileZillaEngine*) {
    { std::lock_guard lock(input_mutex_); notifications_ = true; }
    input_ready_.notify_one();
  }) {}
  ~bridge() { if (key_fd_ >= 0) ::close(key_fd_); }
  void run() {
    std::thread input([this] { read_input(); });
    for (;;) {
      std::deque<json> incoming;
      bool notify;
      {
        std::unique_lock lock(input_mutex_);
        auto available = [this] { return notifications_ || !incoming_.empty(); };
        if (active_ && active_->stage == phase::uploading) {
          // The official GUI polls GetTransferStatus. This only samples sent
          // bytes; the interval never expires, cancels or disconnects a task.
          input_ready_.wait_for(lock, std::chrono::milliseconds(250), available);
        } else input_ready_.wait(lock, available);
        incoming.swap(incoming_); notify = notifications_; notifications_ = false;
      }
      for (auto& value : incoming) receive(std::move(value));
      if (notify) drain_notifications();
      if (active_ && active_->stage == phase::uploading) {
        bool changed{};
        auto status = engine_.GetTransferStatus(changed);
        if (changed) progress(status);
      }
      pump();
      if (closed_) break;
    }
    // A valid close ends the input thread before its command is processed.
    // EOF takes the same path. There is no local duration or idle deadline.
    input.join();
  }
private:
  void read_input() {
    std::string line;
    while (std::getline(std::cin, line)) {
      json value;
      try {
        if (line.size() > 2 * 1024 * 1024) throw std::invalid_argument("large request");
        value = json::parse(line);
      } catch (...) { error("", "INVALID_REQUEST", "文件传输请求不是有效 JSON。"); continue; }
      bool close = value.is_object() && value.contains("type") && value["type"].is_string() &&
        value["type"].get<std::string>() == "close" &&
        value.contains("id") && value["id"].is_string() && !value["id"].get<std::string>().empty() &&
        value["id"].get<std::string>().size() <= 128;
      { std::lock_guard lock(input_mutex_); incoming_.push_back(std::move(value)); }
      input_ready_.notify_one();
      if (close) return;
    }
    { std::lock_guard lock(input_mutex_); incoming_.push_back({{"id", "eof"}, {"type", "close"}}); }
    input_ready_.notify_one();
  }
  void receive(json value) {
    std::string id;
    try {
      if (value.is_object() && value.contains("id") && value["id"].is_string()) id = value["id"].get<std::string>();
      if (id.empty() || id.size() > 128 || !value.contains("type") || !value["type"].is_string())
        throw std::invalid_argument("invalid command");
      auto type = value["type"].get<std::string>();
      if (type == "close") {
        closing_id_ = id;
        for (auto const& pending : queued_) error(pending.value("id", ""), "CONNECTION_CLOSED", "连接正在关闭。");
        queued_.clear(); ids_.clear();
        if (active_ && active_->stage != phase::disconnecting &&
            active_->stage != phase::committing && active_->stage != phase::cleanup) {
          request_cancel();
        }
        return;
      }
      if (!closing_id_.empty()) { error(id, "CLOSING", "连接正在关闭。"); return; }
      if (type == "cancel") { cancel(id, value.at("operationId").get<std::string>()); return; }
      if (type != "connect" && type != "list" && type != "stat" && type != "mkdir" && type != "upload")
        throw std::invalid_argument("unsupported command");
      if (ids_.count(id) || queued_.size() >= 128) { error(id, "BUSY", "请求重复或待处理请求过多。"); return; }
      ids_.insert(id); queued_.push_back(std::move(value));
    } catch (...) { error(id, "INVALID_REQUEST", "文件传输请求无效。"); }
  }
  void cancel(std::string const& id, std::string const& target) {
    if (active_ && active_->id == target && active_->type == "upload" &&
        active_->stage != phase::committing && active_->stage != phase::cleanup) {
      request_cancel(); result(id, {{"cancelled", true}}); return;
    }
    auto it = std::find_if(queued_.begin(), queued_.end(), [&](auto const& value) {
      return value.value("id", "") == target && value.value("type", "") == "upload";
    });
    if (it != queued_.end()) {
      ids_.erase(target); queued_.erase(it); error(target, "CANCELLED", "传输已取消。");
      result(id, {{"cancelled", true}}); return;
    }
    result(id, {{"cancelled", false}});
  }
  void request_cancel() {
    active_->cancelled = true;
    // Do not discard an in-flight OPEN before the official engine has proved
    // it obtained a handle. Its first sent byte proves this; a successful
    // zero-byte transfer proves it in operation_done. No deadline is imposed.
    if (active_->stage == phase::uploading && !active_->owns_temporary) return;
    if (!active_->cancel_dispatched) { active_->cancel_dispatched = true; engine_.Cancel(); }
  }
  void pump() {
    if (active_ || engine_.IsBusy() || closed_) return;
    if (!closing_id_.empty()) {
      active_ = std::make_unique<request_state>(); active_->id = closing_id_; active_->type = "close";
      active_->stage = phase::disconnecting;
      execute(CDisconnectCommand()); return;
    }
    if (queued_.empty()) return;
    auto request = std::move(queued_.front()); queued_.pop_front();
    active_ = std::make_unique<request_state>(); active_->request = request;
    active_->id = request.at("id").get<std::string>(); active_->type = request.at("type").get<std::string>();
    try {
      if (active_->type == "connect") { connect(request); return; }
      if (!engine_.IsConnected()) { finish_error("NOT_CONNECTED", "SFTP 尚未连接。"); return; }
      active_->remote = absolute_remote(request, active_->type == "upload" ? "remotePath" : "path");
      auto path = std::filesystem::path(active_->remote);
      active_->parent = path.parent_path().generic_string(); active_->filename = path.filename().generic_string();
      if (active_->parent.empty()) active_->parent = "/";
      if (active_->type == "list") { list(phase::listing, active_->remote); return; }
      if (active_->remote == "/" && active_->type == "stat") { finish({{"directory", true}, {"symlink", false}, {"size", 0}}); return; }
      if (active_->remote == "/" && active_->type == "mkdir") { finish({{"created", false}}); return; }
      if (active_->filename.empty() || active_->filename == "." || active_->filename == "..") throw std::invalid_argument("invalid remote file");
      if (active_->type == "stat") { list(phase::stat_parent, active_->parent); return; }
      if (active_->type == "mkdir") { list(phase::mkdir_parent, active_->parent); return; }
      try { active_->source = open_confined_source(request); }
      catch (...) { finish_error("LOCAL_FILE_INVALID", "无法安全读取本地文件，请刷新文件夹后重试。"); return; }
      active_->temporary = ".draw-studio-upload-" + fz::hex_encode<std::string>(fz::random_bytes(16)) + ".part";
      list(phase::upload_parent, active_->parent);
    } catch (...) {
      if (active_ && active_->type == "connect") clear_secrets();
      finish_error("INVALID_REQUEST", "文件传输请求无效。");
    }
  }
  void connect(json const& request) {
    if (engine_.IsConnected()) { finish_error("ALREADY_CONNECTED", "当前会话已经建立连接。"); return; }
    auto host = request.at("host").get<std::string>();
    auto user = request.at("username").get<std::string>();
    int port = request.value("port", 22);
    if (host.empty() || host.size() > 253 || !clean(host) || user.empty() || !clean(user) || port < 1 || port > 65535)
      throw std::invalid_argument("invalid connection");
    secret_ = request; host_key_.clear(); fingerprint_.clear();
    expected_key_ = lower(request.value("hostKey", std::string{}));
    CServer server(SFTP, UNIX, fz::to_wstring_from_utf8(host), static_cast<unsigned int>(port));
    server.SetUser(fz::to_wstring_from_utf8(user)); server.SetBypassProxy(true);
    Credentials credentials; credentials.logonType_ = LogonType::normal;
    if (request.contains("password")) credentials.SetPass(fz::to_wstring_from_utf8(request["password"].get<std::string>()));
    if (request.contains("privateKey") && !request["privateKey"].get<std::string>().empty()) {
      auto key = request["privateKey"].get<std::string>();
      key_fd_ = static_cast<int>(::syscall(SYS_memfd_create, "draw-studio-sftp-key", MFD_CLOEXEC | MFD_ALLOW_SEALING));
      if (key_fd_ < 0) throw std::invalid_argument("key storage unavailable");
      size_t offset = 0;
      while (offset < key.size()) {
        auto written = ::write(key_fd_, key.data() + offset, key.size() - offset);
        if (written <= 0) throw std::invalid_argument("key storage unavailable");
        offset += static_cast<size_t>(written);
      }
      ::lseek(key_fd_, 0, SEEK_SET);
      ::fcntl(key_fd_, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL);
      credentials.keyFile_ = fz::to_wstring_from_utf8("/proc/self/fd/" + std::to_string(key_fd_));
    }
    active_->stage = phase::connecting;
    execute(CConnectCommand(server, {}, credentials, false));
  }
  void list(phase stage, std::string const& location, int extra_flags = 0) {
    active_->stage = stage; active_->listing = CDirectoryListing();
    if (stage == phase::upload_parent && !location.empty()) {
      CDirectoryListing cached;
      if (engine_.CacheLookup(server_path(location), cached) == FZ_REPLY_OK &&
          cached && !cached.failed() && !cached.get_unsure_flags()) {
        active_->listing = std::move(cached);
        operation_done(FZ_REPLY_OK, Command::list);
        return;
      }
    }
    int flags = LIST_FLAG_REFRESH | LIST_FLAG_CLEARCACHE | extra_flags;
    if (extra_flags & LIST_FLAG_LINK) {
      auto path = std::filesystem::path(location);
      execute(CListCommand(server_path(path.parent_path().generic_string()),
        fz::to_wstring_from_utf8(path.filename().generic_string()), flags));
    }
    else if (location.empty()) execute(CListCommand(flags));
    else execute(CListCommand(server_path(location), L"", flags));
  }
  void execute(CCommand const& command) {
    int reply = engine_.Execute(command);
    if (reply != FZ_REPLY_WOULDBLOCK) operation_done(reply, command.GetId());
  }
  void finish(json const& value) {
    auto id = active_->id; ids_.erase(id); active_.reset(); result(id, value); pump();
  }
  void finish_error(std::string code, std::string message) {
    if (!active_) return;
    auto id = active_->id; ids_.erase(id); active_.reset(); error(id, code, message); pump();
  }
  void clear_secrets() {
    secret_ = json::object(); expected_key_.clear();
    if (key_fd_ >= 0) { ::close(key_fd_); key_fd_ = -1; }
  }
  void drain_notifications() {
    while (auto notification = engine_.GetNextNotification()) {
      switch (notification->GetID()) {
      case nId_asyncrequest:
        asynchronous(std::unique_ptr<CAsyncRequestNotification>(static_cast<CAsyncRequestNotification*>(notification.release()))); break;
      case nId_listing: {
        auto const& listing = static_cast<CDirectoryListingNotification const&>(*notification);
        if (active_ && !listing.Failed()) {
          CDirectoryListing cached;
          if (engine_.CacheLookup(listing.GetPath(), cached) == FZ_REPLY_OK) active_->listing = std::move(cached);
        }
        break;
      }
      case nId_transferstatus:
        progress(static_cast<CTransferStatusNotification const&>(*notification).GetStatus()); break;
      case nId_operation: {
        auto const& operation = static_cast<COperationNotification const&>(*notification);
        operation_done(operation.replyCode_, operation.commandId_); break;
      }
      default: break; // In particular, never publish engine logs or server text.
      }
    }
  }
  void asynchronous(std::unique_ptr<CAsyncRequestNotification> request) {
    if (!request->IsPending()) return;
    switch (request->GetRequestID()) {
    case reqId_hostkey: {
      auto& hostkey = static_cast<CHostKeyNotification&>(*request);
      auto seen = hostkey.hostkey_->fingerprint(fz::hash_algorithm::sha256, false);
      seen.erase(std::remove(seen.begin(), seen.end(), ':'), seen.end()); seen = lower(std::move(seen));
      host_key_ = seen; fingerprint_ = hostkey.hostkey_->fingerprint();
      hostkey.trust_ = !expected_key_.empty() && expected_key_ == seen;
      if (!hostkey.trust_ && active_) {
        active_->failure_code = expected_key_.empty() ? "HOST_KEY_REQUIRED" : "HOST_KEY_MISMATCH";
        active_->failure_message = expected_key_.empty() ? "请核对服务器指纹后再连接。" : "服务器指纹已变化，请核实后重新连接。";
      }
      break;
    }
    case reqId_fileexists: {
      auto& exists = static_cast<CFileExistsNotification&>(*request);
      exists.overwriteAction = CFileExistsNotification::skip;
      if (active_ && active_->type == "upload") {
        active_->temporary_collision = true;
        active_->failure_code = "FILE_EXISTS";
        active_->failure_message = "云端已存在同名文件，未覆盖原文件。";
      }
      break;
    }
    case reqId_interactiveLogin: {
      auto& login = static_cast<CInteractiveLoginNotification&>(*request);
      if (!host_key_.empty() && expected_key_ == host_key_ && login.prompts_.size() == 1 &&
          !login.prompts_.front().echo_ && secret_.contains("password"))
        login.responses_ = std::vector<std::string>{secret_["password"].get<std::string>()};
      break;
    }
    case reqId_password: {
      auto& password = static_cast<PasswordRequest&>(*request);
      if (!host_key_.empty() && expected_key_ == host_key_ && secret_.contains("password"))
        password.password_ = fz::to_wstring_from_utf8(secret_["password"].get<std::string>());
      break;
    }
    case reqId_keyfile_password: {
      auto& password = static_cast<KeyfilePasswordRequest&>(*request);
      if (!password.repeated_ && !host_key_.empty() && expected_key_ == host_key_ && secret_.contains("passphrase"))
        password.password_ = secret_["passphrase"].get<std::string>();
      break;
    }
    default: break; // All other trust/OTP requests retain their rejecting defaults.
    }
    engine_.SetAsyncRequestReply(std::move(request));
  }
  void progress(CTransferStatus const& status) {
    if (!active_ || active_->stage != phase::uploading || status.list || status.currentOffset < 0) return;
    auto total = static_cast<uint64_t>(active_->source->identity.st_size);
    active_->bytes = std::max(active_->bytes, std::min(total, static_cast<uint64_t>(status.currentOffset)));
    // This is the official engine's sent-byte progress, not an SFTP ACK counter.
    if (active_->bytes) active_->owns_temporary = true;
    if (active_->cancelled && active_->owns_temporary) request_cancel();
    emit({{"event", "progress"}, {"id", active_->id}, {"bytes", active_->bytes}, {"total", total}, {"progressBasis", "engine-sent"}});
  }
  std::optional<CDirentry> find_entry(std::string const& name) const {
    auto wanted = fz::to_wstring_from_utf8(name);
    for (size_t i = 0; i < active_->listing.size(); ++i)
      if (active_->listing[i].name == wanted) return active_->listing[i];
    return {};
  }
  void fail_upload(std::string code, std::string message) {
    active_->failure_code = std::move(code); active_->failure_message = std::move(message);
    if (active_->owns_temporary && !active_->temporary_collision && engine_.IsConnected()) {
      active_->stage = phase::cleanup;
      execute(CDeleteCommand(server_path(active_->parent), {fz::to_wstring_from_utf8(active_->temporary)}));
    } else finish_error(active_->failure_code, active_->failure_message);
  }
  void operation_done(int reply, Command /*command*/) {
    // Send the specific request result first (including host-key challenges),
    // then notify the TypeScript host that the underlying session is closed.
    disconnected_notification disconnected{(reply & FZ_REPLY_DISCONNECTED) != 0};
    if (!active_) {
      return;
    }
    auto stage = active_->stage;
    if (stage == phase::disconnecting) {
      auto id = active_->id; active_.reset(); clear_secrets(); result(id, {{"closed", true}}); closed_ = true; return;
    }
    if (stage == phase::cleanup) {
      auto message = active_->failure_message;
      if (reply != FZ_REPLY_OK) message += " 请检查自己的未完成临时文件。";
      finish_error(active_->failure_code, message); return;
    }
    // A successful transfer also proves ownership of an empty staging file.
    // This must precede the cancel branch when success was already queued by
    // the engine before the main thread received a user's cancellation.
    if (stage == phase::uploading && reply == FZ_REPLY_OK && !active_->temporary_collision)
      active_->owns_temporary = true;
    if (active_->cancelled) {
      if (active_->type == "upload") fail_upload("CANCELLED", "传输已取消。");
      else { clear_secrets(); finish_error("CANCELLED", "操作已取消。"); }
      return;
    }
    if (reply != FZ_REPLY_OK) {
      if (stage == phase::connecting) {
        auto code = active_->failure_code.empty() ? ((reply & FZ_REPLY_PASSWORDFAILED) ? "AUTHENTICATION_FAILED" : "CONNECTION_FAILED") : active_->failure_code;
        auto message = active_->failure_message.empty() ? "SFTP 连接失败，请检查服务器和认证信息。" : active_->failure_message;
        auto id = active_->id; ids_.erase(id); active_.reset(); clear_secrets();
        if (code == "HOST_KEY_REQUIRED" || code == "HOST_KEY_MISMATCH")
          error(id, code, message, {{"hostKey", host_key_}, {"fingerprint", fingerprint_}});
        else error(id, code, message);
        pump(); return;
      }
      if (reply & FZ_REPLY_DISCONNECTED) {
        if (active_->type == "upload") fail_upload("CONNECTION_FAILED", "SFTP 连接中断，未完成的临时文件可能需要清理。");
        else finish_error("CONNECTION_FAILED", "SFTP 连接已断开，请重新连接。");
        return;
      }
      if (stage == phase::stat_link && (reply & FZ_REPLY_LINKNOTDIR) == FZ_REPLY_LINKNOTDIR) {
        auto attrs = entry_attributes(*active_->link); attrs["directory"] = false; finish(attrs); return;
      }
      if (active_->type == "upload") { fail_upload("UPLOAD_FAILED", "云端文件上传失败，请检查连接和目录权限。"); return; }
      finish_error("REMOTE_OPERATION_FAILED", "云端文件操作失败，请检查目录、网络及访问权限。"); return;
    }
    if (stage == phase::connecting) { clear_secrets(); list(phase::home, ""); return; }
    if (stage == phase::home) {
      if (!active_->listing) { finish_error("INVALID_REMOTE_RESPONSE", "云端没有返回初始目录。"); return; }
      auto home = fz::to_utf8(active_->listing.path.GetPath());
      while (home.size() > 1 && home.back() == '/') home.pop_back();
      finish({{"home", home}, {"hostKey", host_key_}, {"fingerprint", fingerprint_}}); return;
    }
    if (stage == phase::listing) {
      if (!active_->listing || active_->listing.size() > 20000) { finish_error("INVALID_REMOTE_ENTRY", "云端目录过大或无法安全读取。"); return; }
      json entries = json::array();
      for (size_t i = 0; i < active_->listing.size(); ++i) {
        auto const& entry = active_->listing[i]; auto name = fz::to_utf8(entry.name);
        if (name == "." || name == "..") continue;
        if (name.empty() || !clean(name) || name.find('/') != std::string::npos || name.find('\\') != std::string::npos) {
          finish_error("INVALID_REMOTE_ENTRY", "云端目录包含无法安全显示的文件名。"); return;
        }
        auto attrs = entry_attributes(entry);
        // The official parser marks unknown links as dir|link for GUI browsing.
        // Preserve our public API: classify a link only when explicitly opened.
        if (entry.is_link()) attrs["directory"] = false;
        attrs["name"] = name; entries.push_back(std::move(attrs));
      }
      finish({{"entries", entries}}); return;
    }
    if (stage == phase::stat_parent) {
      auto entry = find_entry(active_->filename);
      if (!entry) { finish_error("NOT_FOUND", "云端文件不存在。"); return; }
      if (entry->is_link()) { active_->link = std::move(entry); list(phase::stat_link, active_->remote, LIST_FLAG_LINK); }
      else finish(entry_attributes(*entry));
      return;
    }
    if (stage == phase::stat_link) {
      auto attrs = entry_attributes(*active_->link); attrs["directory"] = true; finish(attrs); return;
    }
    if (stage == phase::mkdir_parent) {
      auto entry = find_entry(active_->filename);
      if (entry) {
        if (entry->is_dir()) finish({{"created", false}});
        else finish_error("NOT_DIRECTORY", "云端存在同名文件，无法作为目录上传。");
      } else {
        active_->stage = phase::mkdir_create;
        execute(CMkdirCommand(server_path(active_->remote), transfer_flags::none));
      }
      return;
    }
    if (stage == phase::mkdir_create) { finish({{"created", true}}); return; }
    if (stage == phase::upload_parent) {
      if (find_entry(active_->filename) || find_entry(active_->temporary)) {
        finish_error("FILE_EXISTS", "云端已存在同名文件，未覆盖原文件。"); return;
      }
      active_->stage = phase::uploading;
      descriptor_reader_factory factory(active_->source, context_.GetThreadPool());
      execute(CFileTransferCommand(fz::reader_factory_holder(factory), server_path(active_->parent),
        fz::to_wstring_from_utf8(active_->temporary), transfer_flags::none));
      return;
    }
    if (stage == phase::uploading) {
      if (active_->temporary_collision) { finish_error(active_->failure_code, active_->failure_message); return; }
      active_->owns_temporary = true;
      if (!active_->source->unchanged()) { fail_upload("LOCAL_FILE_CHANGED", "本地文件在上传时发生变化。"); return; }
      active_->stage = phase::committing;
      // Upstream fzSSH uses SFTP v3 SSH_FXP_RENAME, not the overwriting
      // posix-rename extension. A concurrent existing final name must fail.
      execute(CRenameCommand(server_path(active_->parent), fz::to_wstring_from_utf8(active_->temporary),
        server_path(active_->parent), fz::to_wstring_from_utf8(active_->filename)));
      return;
    }
    if (stage == phase::committing) {
      auto total = static_cast<uint64_t>(active_->source->identity.st_size);
      active_->owns_temporary = false;
      emit({{"event", "progress"}, {"id", active_->id}, {"bytes", total}, {"total", total}, {"progressBasis", "engine-sent"}});
      finish({{"bytes", total}, {"total", total}}); return;
    }
    finish_error("INVALID_REMOTE_RESPONSE", "云端返回了无法处理的文件响应。");
  }

  fixed_options options_;
  utf8_converter converter_;
  CFileZillaEngineContext context_;
  std::mutex input_mutex_;
  std::condition_variable input_ready_;
  bool notifications_{};
  std::deque<json> incoming_;
  CFileZillaEngine engine_;
  std::deque<json> queued_;
  std::set<std::string> ids_;
  std::unique_ptr<request_state> active_;
  std::string closing_id_, expected_key_, host_key_, fingerprint_;
  json secret_ = json::object();
  int key_fd_{-1};
  bool closed_{};
};
} // namespace

int main(int argc, char** argv) {
  std::setlocale(LC_ALL, "");
  if (argc == 2 && std::string_view(argv[1]) == "--version") {
    auto version = fz::to_utf8(GetFileZillaEngineVersion());
    emit({{"engine", "FileZilla CFileZillaEngine"}, {"version", version}, {"filezilla", version},
      {"fzssh", fz::ssh::get_version_string()}, {"libfilezilla", fz::get_version_string()},
      {"protocol", "ndjson-v1"}, {"progressBasis", "engine-sent"}});
    return 0;
  }
  try { bridge instance; instance.run(); }
  catch (...) { error("", "ENGINE_FAILED", "FileZilla 原生传输引擎无法启动。"); return 1; }
  return 0;
}
