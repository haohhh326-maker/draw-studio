// Draw studio's headless adapter for the real FileZilla fzssh library.
// Incorporates fzssh, Copyright (C) 2025-2026 Tim Kosse and Business Follows Srl.
// Authentication/event handling follows fzssh 1.4.0's src/client.cpp example.
// Distributed under AGPL-3.0-or-later with the attribution terms in vendor/fzssh-1.4.0/README.
#include <fzssh/client.hpp>
#include <fzssh/privkey.hpp>
#include <fzssh/sftp/sftp_client.hpp>
#include <fzssh/version.hpp>
#include <libfilezilla/event_handler.hpp>
#include <libfilezilla/event_loop.hpp>
#include <libfilezilla/logger.hpp>
#include <libfilezilla/socket.hpp>
#include <libfilezilla/thread_pool.hpp>
#include <libfilezilla/util.hpp>
#include <libfilezilla/version.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <clocale>
#include <condition_variable>
#include <deque>
#include <cctype>
#include <filesystem>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <stdexcept>
#include <fcntl.h>
#include <linux/openat2.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

using json = nlohmann::json;
namespace sf = fz::ssh::sftp;
using continuation = sf::continuation;

namespace {
struct command_event_type {};
using command_event = fz::simple_event<command_event_type, json>;
struct close_check_event_type {};
using close_check_event = fz::simple_event<close_check_event_type>;
std::mutex output_mutex;
void emit(json const& value) { std::lock_guard lock(output_mutex); std::cout << value.dump(-1, ' ', false, json::error_handler_t::replace) << '\n' << std::flush; }
void result(std::string const& id, json const& value) { emit({{"id", id}, {"ok", true}, {"result", value}}); }
void error(std::string const& id, std::string const& code, std::string const& message, json details = json::object()) {
  details["code"] = code; details["message"] = message;
  emit({{"id", id}, {"ok", false}, {"error", std::move(details)}});
}
bool clean(std::string const& value) { return std::none_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; }); }
std::string absolute_remote(json const& request, char const* key = "path") {
  auto value = request.at(key).get<std::string>();
  if (value.empty() || value.front() != '/' || value.size() > 4096 || !clean(value) || value.find('\\') != std::string::npos) throw std::invalid_argument("invalid remote path");
  return std::filesystem::path(value).lexically_normal().generic_string();
}
json attributes(sf::attributes const& info) {
  json value{{"directory", info.is_directory()}, {"symlink", info.is_symlink()}, {"size", info.size_.value_or(0)}};
  if (info.modified_) value["modified"] = static_cast<int64_t>(info.modified_->get_time_t()) * 1000;
  return value;
}
class silent_logger final : public fz::logger_interface {
public:
  silent_logger() { set_all(static_cast<fz::logmsg::type>(0)); }
  void do_log(fz::logmsg::type, std::wstring&&) override {} // Never echo credentials/server text to IPC.
};
class runner;
enum class operation_kind { home, list, stat, mkdir, upload };
class operation final : public sf::response_handler {
public:
  operation(runner& owner, std::string id, operation_kind kind, std::string remote);
  ~operation() override { if (fd_ >= 0) ::close(fd_); }
  void start(json const& request);
  void cancel();
  void lost();
  void resume() { if (!done_ && created_ && stage_ == stage::writing) next_chunk(); }
  bool done() const { return done_; }
  bool uploading() const { return kind_ == operation_kind::upload; }
  continuation process_status(sf::status_code status, std::string_view) override;
  continuation process_handle(std::string_view handle) override;
  continuation process_name(sf::entry& entry, bool more) override;
  continuation process_names_end() override;
  continuation process_attributes(sf::attributes& attrs) override;
  continuation failure() override;
private:
  void complete(json const& value);
  void fail(std::string code, std::string message);
  void finish_failure();
  void cleanup();
  void next_chunk();
  void close_handle();
  runner& owner_;
  std::string id_, remote_, handle_, failure_code_, failure_message_;
  operation_kind kind_;
  enum class stage { initial, directory, writing, closing, removing, mkdir_check, exists_check } stage_ = stage::initial;
  json entries_ = json::array();
  int fd_ = -1;
  uint64_t total_ = 0, bytes_ = 0, queued_ = 0;
  std::deque<size_t> pending_writes_;
  timespec source_modified_{};
  // Keep uploads bounded without limiting a WAN link to 512 KiB per round trip.
  // Upstream's initial 16-request limit is for downloads, not uploads.
  // fzssh limits an entire WRITE payload (including its header) to 64 KiB.
  static constexpr size_t max_pending_writes = 128; // At most 4 MiB of unacknowledged file data.
  std::array<char, 32768> buffer_{};
  bool done_ = false, created_ = false, cancelled_ = false, eof_ = false;
};

class runner final : public fz::event_handler {
public:
  runner(fz::event_loop& loop, fz::thread_pool& pool) : fz::event_handler(loop), loop_(loop), pool_(pool) {}
  ~runner() override { remove_handler(); sftp_.reset(); operations_.clear(); ssh_.reset(); socket_.reset(); }
  sf::sftp_client& sftp() { return *sftp_; }
  json identity(std::string const& home) const { return {{"home", home}, {"hostKey", host_key_}, {"fingerprint", fingerprint_}}; }
  void wait_closed() { std::unique_lock lock(close_mutex_); closed_condition_.wait(lock, [this] { return closed_; }); }
  void operator()(fz::event_base const& event) override {
    fz::dispatch<command_event, fz::socket_event, fz::ssh::hostkey_verification_event,
      fz::ssh::auth_requested_event, fz::ssh::auth_done_event, fz::ssh::session_done_event,
      fz::ssh::auth_keyboard_interactive_prompt_event, fz::ssh::auth_signature_failure_event,
      sf::sftp_client::ready_event, sf::sftp_client::done_event, sf::outbuf_empty_event, close_check_event>(event, this,
      &runner::on_command, &runner::on_socket, &runner::on_hostkey, &runner::on_auth_requested,
      &runner::on_auth_done, &runner::on_session_done, &runner::on_keyboard, &runner::on_signature_failure,
      &runner::on_sftp_ready, &runner::on_sftp_done, &runner::on_can_send, &runner::on_close_check);
  }
private:
  friend class operation;
  void on_command(json const& request) {
    std::string id;
    try {
      if (request.is_object() && request.contains("id") && request["id"].is_string()) id = request["id"].get<std::string>();
      if (!request.is_object() || id.empty() || id.size() > 128) throw std::invalid_argument("invalid id");
      for (auto it = operations_.begin(); it != operations_.end();) { if (it->second->done()) it = operations_.erase(it); else ++it; }
      auto type = request.at("type").get<std::string>();
      if (type == "close") {
        closing_id_ = id;
        for (auto& [_, op] : operations_) if (!op->done()) op->cancel();
        send_event<close_check_event>();
        return;
      }
      if (!closing_id_.empty()) { error(id, "CLOSING", "连接正在关闭。"); return; }
      if (type == "cancel") {
        auto target = request.at("operationId").get<std::string>(); auto found = operations_.find(target);
        bool cancelled = found != operations_.end() && found->second->uploading() && !found->second->done();
        if (cancelled) found->second->cancel();
        result(id, {{"cancelled", cancelled}}); return;
      }
      if (type == "connect") { connect(request, id); return; }
      if (!ready_ || !sftp_) { error(id, "NOT_CONNECTED", "SFTP 尚未连接。"); return; }
      if (operations_.count(id) || operations_.size() >= 128) { error(id, "BUSY", "请求重复或待处理请求过多。"); return; }
      operation_kind kind;
      if (type == "list") kind = operation_kind::list;
      else if (type == "stat") kind = operation_kind::stat;
      else if (type == "mkdir") kind = operation_kind::mkdir;
      else if (type == "upload") kind = operation_kind::upload;
      else { error(id, "INVALID_REQUEST", "不支持此文件操作。"); return; }
      auto remote = absolute_remote(request, kind == operation_kind::upload ? "remotePath" : "path");
      auto op = std::make_unique<operation>(*this, id, kind, remote);
      auto pointer = op.get(); operations_.emplace(id, std::move(op)); pointer->start(request);
    } catch (...) { error(id, "INVALID_REQUEST", "文件传输请求无效。"); }
  }
  void connect(json const& request, std::string const& id) {
    if (socket_ || ssh_ || !connect_id_.empty()) { error(id, "ALREADY_CONNECTED", "当前会话已经建立连接。"); return; }
    auto host = request.at("host").get<std::string>(); auto port = request.value("port", 22); auto user = request.at("username").get<std::string>();
    if (host.empty() || host.size() > 253 || !clean(host) || user.empty() || !clean(user) || port < 1 || port > 65535) throw std::invalid_argument("invalid connection");
    credentials_ = request; connect_id_ = id;
    password_tried_ = key_tried_ = keyboard_tried_ = false; host_key_.clear(); fingerprint_.clear();
    socket_ = std::make_unique<fz::socket>(pool_, this);
    if (socket_->connect(fz::to_native(host), static_cast<unsigned>(port))) connect_error("CONNECTION_FAILED", "无法建立 SFTP 网络连接。");
  }
  void connect_error(std::string const& code, std::string const& message) {
    if (!connect_id_.empty()) { error(connect_id_, code, message); connect_id_.clear(); }
    credentials_ = json::object();
  }
  void on_socket(fz::socket_event_source* source, fz::socket_event_flag flag, int failure) {
    if (failure) { connect_error("CONNECTION_FAILED", "无法建立 SFTP 网络连接。"); return; }
    if (!connect_id_.empty() && source == socket_.get() && flag == fz::socket_event_flag::connection) {
      fz::ssh::client_parameters params; params.single_channel_ = true; params.softwareversion_ = "DrawStudio-FileZilla-fzssh";
      ssh_ = std::make_unique<fz::ssh::client>(params, credentials_.at("username").get<std::string>(), *socket_, *this, logger_);
    }
  }
  void on_hostkey(fz::ssh::session* source, std::unique_ptr<fz::ssh::public_key> const& key, fz::ssh::algorithm_info const&) {
    if (source != ssh_.get()) return;
    auto seen = key->fingerprint(fz::hash_algorithm::sha256, false); seen.erase(std::remove(seen.begin(), seen.end(), ':'), seen.end());
    std::transform(seen.begin(), seen.end(), seen.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    auto expected = credentials_.value("hostKey", host_key_);
    std::transform(expected.begin(), expected.end(), expected.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    fingerprint_ = key->fingerprint();
    bool accept = !expected.empty() && expected == seen;
    if (!accept) {
      if (!connect_id_.empty()) error(connect_id_, expected.empty() ? "HOST_KEY_REQUIRED" : "HOST_KEY_MISMATCH", expected.empty() ? "请核对服务器指纹后再连接。" : "服务器指纹已变化，请核实后重新连接。", {{"hostKey", seen}, {"fingerprint", fingerprint_}});
      connect_id_.clear(); credentials_ = json::object();
    }
    host_key_ = seen; ssh_->hostkey_decision(accept);
  }
  void on_auth_requested(fz::ssh::session* source, std::string const& methods, bool) {
    if (source != ssh_.get()) return;
    if (!key_tried_ && credentials_.contains("privateKey") && !credentials_["privateKey"].get<std::string>().empty() && methods.find("publickey") != std::string::npos) {
      key_tried_ = true; std::optional<std::string_view> passphrase;
      auto key_data = credentials_["privateKey"].get<std::string>(), password = credentials_.value("passphrase", std::string{});
      if (!password.empty()) passphrase = password;
      private_key_ = fz::ssh::load_private_key(key_data, logger_, passphrase);
      if (private_key_) { ssh_->auth_with_key(private_key_, true); return; }
    }
    if (!password_tried_ && credentials_.contains("password") && methods.find("password") != std::string::npos) {
      password_tried_ = true; ssh_->auth_with_password(credentials_["password"].get<std::string>()); return;
    }
    if (!keyboard_tried_ && credentials_.contains("password") && methods.find("keyboard-interactive") != std::string::npos) {
      keyboard_tried_ = true; ssh_->auth_keyboard_interactive(); return;
    }
    connect_error("AUTHENTICATION_FAILED", "SFTP 认证失败，请检查用户名、密码或私钥。");
  }
  void on_keyboard(fz::ssh::session* source, std::string const&, std::string const&, std::vector<fz::ssh::keyboard_interactive_prompt> const& prompts) {
    if (source != ssh_.get()) return;
    if (prompts.size() == 1 && !prompts.front().echo_ && credentials_.contains("password")) ssh_->auth_keyboard_interactive_response({credentials_["password"].get<std::string>()});
    else connect_error("AUTHENTICATION_FAILED", "服务器要求额外的交互式认证。");
  }
  void on_signature_failure(fz::ssh::session*) { connect_error("AUTHENTICATION_FAILED", "SFTP 私钥签名失败。"); }
  void on_auth_done(fz::ssh::session* source) {
    if (source != ssh_.get()) return;
    credentials_ = json::object(); private_key_.reset();
    auto channel = ssh_->open_channel(fz::ssh::channel_type::subsystem, "sftp");
    sftp_ = std::make_unique<sf::sftp_client>(std::move(channel), *this, logger_);
  }
  void on_sftp_ready(sf::sftp_client* source) {
    if (source != sftp_.get()) return;
    ready_ = true;
    auto id = connect_id_; connect_id_.clear();
    auto op = std::make_unique<operation>(*this, id, operation_kind::home, "."); auto pointer = op.get(); operations_.emplace(id, std::move(op)); pointer->start(json::object());
  }
  void on_session_done(fz::ssh::session*) { connection_lost(); }
  void on_sftp_done(sf::sftp_client*) { connection_lost(); }
  void on_can_send(sf::sftp_client* source) { if (source == sftp_.get()) for (auto& [_, op] : operations_) op->resume(); }
  void connection_lost() {
    if (!socket_ && !ssh_) return;
    ready_ = false; connect_error("CONNECTION_FAILED", "SFTP 连接已断开。");
    for (auto& [_, op] : operations_) if (!op->done()) op->lost();
    sftp_.reset(); ssh_.reset(); socket_.reset(); emit({{"event", "disconnected"}});
  }
  void on_close_check() {
    if (!closing_id_.empty()) {
      bool active = std::any_of(operations_.begin(), operations_.end(), [](auto const& item) { return !item.second->done(); });
      if (!active) {
        result(closing_id_, {{"closed", true}}); ready_ = false; sftp_.reset(); ssh_.reset(); socket_.reset();
        { std::lock_guard lock(close_mutex_); closed_ = true; }
        closed_condition_.notify_all(); loop_.stop();
      }
    }
  }
  fz::event_loop& loop_;
  fz::thread_pool& pool_;
  silent_logger logger_;
  std::unique_ptr<fz::socket> socket_;
  std::unique_ptr<fz::ssh::client> ssh_;
  std::unique_ptr<fz::ssh::private_key> private_key_;
  std::unique_ptr<sf::sftp_client> sftp_;
  std::map<std::string, std::unique_ptr<operation>> operations_;
  json credentials_ = json::object();
  std::string connect_id_, closing_id_, host_key_, fingerprint_;
  bool ready_ = false, password_tried_ = false, key_tried_ = false, keyboard_tried_ = false;
  std::mutex close_mutex_;
  std::condition_variable closed_condition_;
  bool closed_ = false;
};

operation::operation(runner& owner, std::string id, operation_kind kind, std::string remote) : owner_(owner), id_(std::move(id)), remote_(std::move(remote)), kind_(kind) {}
void operation::start(json const& request) {
  if (kind_ == operation_kind::home) owner_.sftp().realpath(this, ".");
  else if (kind_ == operation_kind::list) owner_.sftp().opendir(this, remote_);
  else if (kind_ == operation_kind::stat) owner_.sftp().stat(this, remote_);
  else if (kind_ == operation_kind::mkdir) { sf::attributes attrs; attrs.perms_ = 0755; owner_.sftp().mkdir(this, remote_, attrs); }
  else {
    try {
      auto filename = request.at("localPath").get<std::string>();
      if (filename.empty() || filename.front() != '/' || filename.size() > 4096 || !clean(filename)) throw std::invalid_argument("invalid local path");
      auto allowed = request.at("allowedRoot").get<std::string>();
      if (allowed.empty() || allowed.front() != '/' || !clean(allowed)) throw std::invalid_argument("invalid local root");
      auto allowed_root = std::filesystem::canonical(allowed);
      if (allowed_root != std::filesystem::path(allowed).lexically_normal()) throw std::invalid_argument("local root changed");
      auto canonical = std::filesystem::canonical(filename);
      auto relative = canonical.lexically_relative(allowed_root);
      if (!std::filesystem::is_directory(allowed_root) || relative.empty() || relative.is_absolute() || *relative.begin() == "..") throw std::invalid_argument("outside local root");
      struct stat before{}, opened{};
      if (::stat(canonical.c_str(), &before) || !S_ISREG(before.st_mode)) throw std::invalid_argument("invalid local file");
      // Resolve beneath an already opened bucket descriptor, so replacing a parent
      // directory with a symlink cannot make the actual read escape the bucket.
      int root_fd = ::open(allowed_root.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (root_fd < 0) throw std::invalid_argument("invalid local root");
      try {
        if (std::filesystem::canonical("/proc/self/fd/" + std::to_string(root_fd)) != allowed_root) throw std::invalid_argument("local root changed");
        open_how how{};
        how.flags = O_RDONLY | O_CLOEXEC;
        how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS;
        fd_ = static_cast<int>(::syscall(SYS_openat2, root_fd, relative.c_str(), &how, sizeof(how)));
      } catch (...) { ::close(root_fd); throw; }
      ::close(root_fd);
      if (fd_ < 0 || ::fstat(fd_, &opened) || !S_ISREG(opened.st_mode) || before.st_dev != opened.st_dev || before.st_ino != opened.st_ino) throw std::invalid_argument("file changed");
      total_ = static_cast<uint64_t>(opened.st_size);
      source_modified_ = opened.st_mtim;
      if (request.contains("expectedIdentity")) {
        auto expected = request.at("expectedIdentity");
        double modified = static_cast<double>(opened.st_mtim.tv_sec) * 1000.0 + static_cast<double>(opened.st_mtim.tv_nsec) / 1000000.0;
        if (expected.at("size").get<uint64_t>() != total_ || std::abs(expected.at("mtimeMs").get<double>() - modified) > 2.0) throw std::invalid_argument("file changed");
      }
      sf::attributes attrs; attrs.perms_ = 0644;
      owner_.sftp().open(this, remote_, sf::file_flags::SSH_FXF_WRITE | sf::file_flags::SSH_FXF_CREAT | sf::file_flags::SSH_FXF_EXCL, attrs);
    } catch (...) { fail("LOCAL_FILE_INVALID", "无法安全读取本地文件，请刷新文件夹后重试。"); }
  }
}
void operation::complete(json const& value) { if (done_) return; done_ = true; if (fd_ >= 0) { ::close(fd_); fd_ = -1; } owner_.sftp().cancel(this); result(id_, value); if (!owner_.closing_id_.empty()) owner_.send_event<close_check_event>(); }
void operation::finish_failure() { if (done_) return; done_ = true; if (fd_ >= 0) { ::close(fd_); fd_ = -1; } if (owner_.sftp_) owner_.sftp().cancel(this); error(id_, failure_code_, failure_message_); if (!owner_.closing_id_.empty()) owner_.send_event<close_check_event>(); }
void operation::fail(std::string code, std::string message) {
  if (done_) return;
  failure_code_ = std::move(code); failure_message_ = std::move(message);
  if (kind_ == operation_kind::upload && created_ && !pending_writes_.empty()) return; // Drain WRITE acknowledgements before closing/removing.
  if (kind_ == operation_kind::upload && created_ && owner_.sftp_) cleanup();
  else if (kind_ == operation_kind::list && !handle_.empty() && owner_.sftp_) close_handle();
  else finish_failure();
}
void operation::close_handle() { stage_ = stage::closing; owner_.sftp().close(this, handle_); }
void operation::cleanup() {
  if (!handle_.empty()) close_handle();
  else { stage_ = stage::removing; owner_.sftp().remove(this, remote_); }
}
void operation::cancel() {
  if (done_) return;
  cancelled_ = true; failure_code_ = "CANCELLED"; failure_message_ = "传输已取消。";
  // Do not drop the OPEN response: it tells us whether this operation owns a newly created file.
  if (kind_ != operation_kind::upload) { if (!handle_.empty()) close_handle(); else finish_failure(); }
  else if (!created_) { if (stage_ != stage::initial) finish_failure(); /* Wait for OPEN only; a failed OPEN never grants deletion rights. */ }
  else if (stage_ != stage::writing && stage_ != stage::closing && stage_ != stage::removing) cleanup();
}
void operation::lost() { if (done_) return; failure_code_ = "CONNECTION_FAILED"; failure_message_ = "SFTP 连接中断，未完成的文件可能需要重新上传。"; finish_failure(); }
void operation::next_chunk() {
  if (stage_ == stage::closing || stage_ == stage::removing) return;
  stage_ = stage::writing;
  if (cancelled_ || !failure_code_.empty()) { if (pending_writes_.empty()) cleanup(); return; }
  while (!eof_ && pending_writes_.size() < max_pending_writes && owner_.sftp().can_send_packets(owner_)) {
    auto count = ::read(fd_, buffer_.data(), buffer_.size());
    if (count < 0 || queued_ + static_cast<uint64_t>(std::max<ssize_t>(0, count)) > total_) { fail("LOCAL_FILE_CHANGED", "本地文件在上传时发生变化。"); return; }
    if (!count) {
      struct stat current{};
      if (queued_ != total_ || ::fstat(fd_, &current) || static_cast<uint64_t>(current.st_size) != total_ || current.st_mtim.tv_sec != source_modified_.tv_sec || current.st_mtim.tv_nsec != source_modified_.tv_nsec) { fail("LOCAL_FILE_CHANGED", "本地文件在上传时发生变化。"); return; }
      eof_ = true; break;
    }
    auto size = static_cast<size_t>(count); pending_writes_.push_back(size);
    // fzssh copies each payload into its bounded output buffer before returning.
    owner_.sftp().write(this, handle_, queued_, std::string_view(buffer_.data(), size));
    queued_ += size;
  }
  if (eof_ && pending_writes_.empty()) close_handle();
}
continuation operation::process_handle(std::string_view handle) {
  if (done_) return continuation::next;
  handle_ = handle;
  if (kind_ == operation_kind::list) { stage_ = stage::directory; owner_.sftp().readdir(this, handle_); }
  else { created_ = true; if (cancelled_) cleanup(); else next_chunk(); }
  return continuation::next;
}
continuation operation::process_name(sf::entry& entry, bool /*more*/) {
  if (done_) return continuation::next;
  if (kind_ == operation_kind::home) { complete(owner_.identity(std::string(entry.name_))); return continuation::next; }
  if (kind_ == operation_kind::list) {
    if (stage_ != stage::directory || !failure_code_.empty()) return continuation::next;
    std::string name(entry.name_);
    if (name != "." && name != "..") {
      if (name.empty() || !clean(name) || name.find('/') != std::string::npos || name.find('\\') != std::string::npos || entries_.size() >= 20000) { fail("INVALID_REMOTE_ENTRY", "云端目录包含无法安全显示的文件名或文件过多。"); return continuation::next; }
      auto value = attributes(entry); value["name"] = name; entries_.push_back(std::move(value));
    }
  }
  return continuation::next;
}
continuation operation::process_names_end() {
  if (!done_ && kind_ == operation_kind::list && stage_ == stage::directory && failure_code_.empty()) owner_.sftp().readdir(this, handle_);
  return continuation::next;
}
continuation operation::process_attributes(sf::attributes& attrs) {
  if (done_) return continuation::next;
  if (stage_ == stage::exists_check) { fail("FILE_EXISTS", "云端已存在同名文件，未覆盖原文件。"); }
  else if (kind_ == operation_kind::mkdir && stage_ == stage::mkdir_check) {
    if (attrs.is_directory()) complete({{"created", false}}); else fail("NOT_DIRECTORY", "云端存在同名文件，无法作为目录上传。");
  } else complete(attributes(attrs));
  return continuation::next;
}
continuation operation::process_status(sf::status_code status, std::string_view) {
  if (done_) return continuation::next;
  bool okay = status == sf::status_code::SSH_FX_OK;
  if (stage_ == stage::removing) { created_ = false; if (!okay && status != sf::status_code::SSH_FX_NO_SUCH_FILE) failure_message_ += " 请重新连接后检查未完成的文件。"; finish_failure(); return continuation::next; }
  if (stage_ == stage::closing) {
    handle_.clear();
    if (kind_ == operation_kind::upload) {
      if (!okay && failure_code_.empty()) { failure_code_ = "UPLOAD_FAILED"; failure_message_ = "云端无法完成文件写入。"; }
      if (!failure_code_.empty()) cleanup(); else { created_ = false; complete({{"bytes", bytes_}, {"total", total_}}); }
    } else if (!failure_code_.empty()) finish_failure(); else complete({{"entries", entries_}});
    return continuation::next;
  }
  if (kind_ == operation_kind::list && status == sf::status_code::SSH_FX_EOF) { close_handle(); return continuation::next; }
  if (kind_ == operation_kind::mkdir && stage_ == stage::initial) {
    if (okay) complete({{"created", true}});
    else { stage_ = stage::mkdir_check; owner_.sftp().stat(this, remote_); }
    return continuation::next;
  }
  if (kind_ == operation_kind::upload && stage_ == stage::writing && !pending_writes_.empty()) {
    auto acknowledged = pending_writes_.front(); pending_writes_.pop_front();
    if (okay) { bytes_ += acknowledged; emit({{"event", "progress"}, {"id", id_}, {"bytes", bytes_}, {"total", total_}}); }
    else { failure_code_ = cancelled_ ? "CANCELLED" : "UPLOAD_FAILED"; failure_message_ = cancelled_ ? "传输已取消。" : "云端文件写入失败，请检查网络和目录权限。"; }
    next_chunk(); return continuation::next;
  }
  if (!okay) {
    if (kind_ == operation_kind::upload && stage_ == stage::initial && !created_) { stage_ = stage::exists_check; owner_.sftp().stat(this, remote_); return continuation::next; }
    auto code = status == sf::status_code::SSH_FX_NO_SUCH_FILE ? "NOT_FOUND" : status == sf::status_code::SSH_FX_PERMISSION_DENIED ? "PERMISSION_DENIED" : "REMOTE_OPERATION_FAILED";
    auto message = kind_ == operation_kind::upload && !created_ ? "无法新建云端文件；可能存在同名文件或没有写入权限，未覆盖已有文件。" : "云端文件操作失败，请检查目录、网络及访问权限。";
    fail(code, message);
  } else fail("INVALID_REMOTE_RESPONSE", "云端返回了无法处理的文件响应。");
  return continuation::next;
}
continuation operation::failure() {
  if (kind_ == operation_kind::upload && stage_ == stage::writing && !pending_writes_.empty()) pending_writes_.pop_front();
  fail("INVALID_REMOTE_RESPONSE", "云端返回了无效的 SFTP 响应。");
  return continuation::next;
}
} // namespace

int main(int argc, char** argv) {
  std::setlocale(LC_ALL, "");
  if (argc == 2 && std::string_view(argv[1]) == "--version") { emit({{"engine", "fzssh"}, {"version", fz::ssh::get_version_string()}, {"fzssh", fz::ssh::get_version_string()}, {"libfilezilla", fz::get_version_string()}, {"protocol", "ndjson-v1"}}); return 0; }
  fz::thread_pool pool; fz::event_loop loop; runner bridge(loop, pool);
  std::string line; bool closing = false;
  while (std::getline(std::cin, line)) {
    try {
      if (line.size() > 2 * 1024 * 1024) { error("", "INVALID_REQUEST", "文件传输请求过大。"); continue; }
      auto request = json::parse(line);
      closing = request.is_object() && request.value("type", std::string{}) == "close" && request.contains("id") && request["id"].is_string() && !request["id"].get<std::string>().empty() && request["id"].get<std::string>().size() <= 128;
      bridge.send_event<command_event>(std::move(request));
      if (closing) break;
    } catch (...) { error("", "INVALID_REQUEST", "文件传输请求不是有效 JSON。"); }
  }
  if (!closing) bridge.send_event<command_event>(json{{"id", "eof"}, {"type", "close"}});
  bridge.wait_closed(); loop.stop(true); return 0;
}
