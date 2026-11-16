cmake_minimum_required(VERSION 3.16)
project(canvas_filezilla_transfer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
find_package(PkgConfig REQUIRED)
pkg_check_modules(FZSSH REQUIRED IMPORTED_TARGET libfzssh-client>=1.4.0)
pkg_check_modules(LIBFILEZILLA REQUIRED IMPORTED_TARGET libfilezilla>=0.57.0)
find_package(nlohmann_json 3.2.0 REQUIRED)
find_package(Threads REQUIRED)

set(FILEZILLA_BUILD_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.cache/native-filezilla-official" CACHE PATH "Isolated official FileZilla engine build")
find_library(FILEZILLA_ENGINE_LIBRARY NAMES fzclient-private-3.71.0
  PATHS "${FILEZILLA_BUILD_ROOT}/prefix/lib" NO_DEFAULT_PATH REQUIRED)

add_executable(cloud-transfer-bridge official-bridge.cpp)
target_include_directories(cloud-transfer-bridge PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/vendor/filezilla-3.71.0/src/include"
  "${FILEZILLA_BUILD_ROOT}/filezilla/config")
target_compile_definitions(cloud-transfer-bridge PRIVATE HAVE_CONFIG_H)
target_link_libraries(cloud-transfer-bridge PRIVATE "${FILEZILLA_ENGINE_LIBRARY}"
  PkgConfig::FZSSH PkgConfig::LIBFILEZILLA nlohmann_json::nlohmann_json Threads::Threads)
target_compile_options(cloud-transfer-bridge PRIVATE -Wall -Wextra -Wpedantic)
set_target_properties(cloud-transfer-bridge PROPERTIES BUILD_RPATH "${FILEZILLA_BUILD_ROOT}/prefix/lib;${FZSSH_LIBRARY_DIRS};${LIBFILEZILLA_LIBRARY_DIRS}")
