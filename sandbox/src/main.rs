//! Runs a program confined by Landlock, with the policy read from the environment: Playwright can give a browser only
//! an executable and its environment.
//!
//! - `AGENT_SANDBOX_EXEC`: the program, run with this program's arguments
//! - `AGENT_SANDBOX_READ`, `AGENT_SANDBOX_WRITE`: the paths (one per line) whose trees may be read and executed, or
//!   also written. Paths that do not exist are left out
//! - `AGENT_SANDBOX_TCP`: the TCP ports (one per line) that may be connected to; unset, any. TCP ports are never bound,
//!   and UDP is never used
//! - `AGENT_SANDBOX_UNIX`: the UNIX sockets made outside (one per line) that may be connected to, such as a display's.
//!   No other: the user's D-Bus would let the program start anything outside the sandbox through systemd
//!
//! Landlock ABI 10 is required: ABI 9 controls connecting to UNIX sockets by their path, and ABI 10 controls UDP. On an
//! older kernel the program is not run at all, rather than run less confined.

use std::{
	convert::Infallible,
	env,
	ffi::{OsStr, OsString},
	fs::{File, OpenOptions},
	io,
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd},
		unix::{ffi::OsStrExt, fs::OpenOptionsExt, process::CommandExt},
	},
	process::{Command, ExitCode},
};

const EXEC: &str = "AGENT_SANDBOX_EXEC";
const READ: &str = "AGENT_SANDBOX_READ";
const WRITE: &str = "AGENT_SANDBOX_WRITE";
const TCP: &str = "AGENT_SANDBOX_TCP";
const UNIX: &str = "AGENT_SANDBOX_UNIX";

mod landlock {
	pub const CREATE_RULESET_VERSION: u32 = 1 << 0;
	pub const RULE_PATH_BENEATH: i32 = 1;
	pub const RULE_NET_PORT: i32 = 2;

	pub const FS_EXECUTE: u64 = 1 << 0;
	pub const FS_WRITE_FILE: u64 = 1 << 1;
	pub const FS_READ_FILE: u64 = 1 << 2;
	pub const FS_READ_DIR: u64 = 1 << 3;
	pub const FS_REFER: u64 = 1 << 13;
	pub const FS_TRUNCATE: u64 = 1 << 14;
	pub const FS_IOCTL_DEV: u64 = 1 << 15;
	pub const FS_RESOLVE_UNIX: u64 = 1 << 16;
	/// From EXECUTE to MAKE_SYM: the rights of ABI 1.
	pub const FS_ABI1: u64 = (1 << 13) - 1;
	pub const FS_ALL: u64 = FS_ABI1 | FS_REFER | FS_TRUNCATE | FS_IOCTL_DEV | FS_RESOLVE_UNIX;
	pub const FS_FILE: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV | FS_RESOLVE_UNIX;

	pub const NET_BIND_TCP: u64 = 1 << 0;
	pub const NET_CONNECT_TCP: u64 = 1 << 1;
	pub const NET_BIND_UDP: u64 = 1 << 2;
	pub const NET_CONNECT_SEND_UDP: u64 = 1 << 3;

	pub const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
	pub const SCOPE_SIGNAL: u64 = 1 << 1;

	#[repr(C)]
	pub struct RulesetAttr {
		pub handled_access_fs: u64,
		pub handled_access_net: u64,
		pub scoped: u64,
	}

	#[repr(C, packed)]
	pub struct PathBeneathAttr {
		pub allowed_access: u64,
		pub parent_fd: i32,
	}

	#[repr(C)]
	pub struct NetPortAttr {
		pub allowed_access: u64,
		pub port: u64,
	}
}

struct Policy {
	program: OsString,
	read: Vec<OsString>,
	write: Vec<OsString>,
	tcp: Option<Vec<u16>>,
	unix: Vec<OsString>,
}

impl Policy {
	fn from_env() -> Result<Self, String> {
		let lines = |name: &str| -> Vec<OsString> {
			env::var_os(name)
				.map(|value| value.as_bytes().split(|&b| b == b'\n').filter(|line| !line.is_empty()).map(|line| OsStr::from_bytes(line).to_owned()).collect())
				.unwrap_or_default()
		};
		let tcp = match env::var_os(TCP) {
			None => None,
			Some(_) => Some(
				lines(TCP)
					.iter()
					.map(|port| port.to_str().and_then(|port| port.parse().ok()).ok_or_else(|| format!("{TCP}: not a port: {port:?}")))
					.collect::<Result<_, _>>()?,
			),
		};
		Ok(Self {
			program: env::var_os(EXEC).ok_or_else(|| format!("{EXEC} is not set"))?,
			read: lines(READ),
			write: lines(WRITE),
			tcp,
			unix: lines(UNIX),
		})
	}
}

fn last_error(what: &str) -> String {
	format!("{what}: {}", io::Error::last_os_error())
}

fn abi() -> Result<i64, String> {
	let abi = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<u8>(), 0usize, landlock::CREATE_RULESET_VERSION) };
	if abi < 0 {
		return Err(last_error("Landlock is not available"));
	}
	if abi < 10 {
		return Err(format!("Landlock ABI {abi} is older than 10, which controls UNIX sockets and UDP"));
	}
	Ok(abi)
}

fn add_path(ruleset: &OwnedFd, path: &OsStr, rights: u64) -> Result<(), String> {
	let file = match OpenOptions::new().read(true).custom_flags(libc::O_PATH | libc::O_CLOEXEC).open(path) {
		Ok(file) => file,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(format!("{path:?}: {error}")),
	};
	let is_dir = File::metadata(&file).map_err(|error| format!("{path:?}: {error}"))?.is_dir();
	let attr = landlock::PathBeneathAttr {
		allowed_access: if is_dir { rights } else { rights & landlock::FS_FILE },
		parent_fd: file.as_raw_fd(),
	};
	if unsafe { libc::syscall(libc::SYS_landlock_add_rule, ruleset.as_raw_fd(), landlock::RULE_PATH_BENEATH, &attr, 0u32) } < 0 {
		return Err(last_error(&format!("rule for {path:?}")));
	}
	Ok(())
}

fn restrict(policy: &Policy) -> Result<(), String> {
	abi()?;
	let fs = landlock::FS_ALL;
	let attr = landlock::RulesetAttr {
		handled_access_fs: fs,
		handled_access_net: landlock::NET_BIND_TCP
			| landlock::NET_BIND_UDP
			| landlock::NET_CONNECT_SEND_UDP
			| if policy.tcp.is_some() { landlock::NET_CONNECT_TCP } else { 0 },
		scoped: landlock::SCOPE_SIGNAL | landlock::SCOPE_ABSTRACT_UNIX_SOCKET,
	};
	let fd = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, &attr, size_of::<landlock::RulesetAttr>(), 0u32) };
	if fd < 0 {
		return Err(last_error("Landlock ruleset"));
	}
	let ruleset = unsafe { OwnedFd::from_raw_fd(fd as i32) };
	for path in &policy.read {
		add_path(&ruleset, path, landlock::FS_EXECUTE | landlock::FS_READ_FILE | landlock::FS_READ_DIR)?;
	}
	for path in &policy.write {
		// Not RESOLVE_UNIX: a socket the program made itself is reachable without it, and with it any socket put in a
		// writable directory from outside (the temporary directory is shared) would be too.
		add_path(&ruleset, path, fs & !landlock::FS_RESOLVE_UNIX)?;
	}
	for path in &policy.unix {
		add_path(&ruleset, path, landlock::FS_RESOLVE_UNIX)?;
	}
	for &port in policy.tcp.iter().flatten() {
		let attr = landlock::NetPortAttr { allowed_access: landlock::NET_CONNECT_TCP, port: port.into() };
		if unsafe { libc::syscall(libc::SYS_landlock_add_rule, ruleset.as_raw_fd(), landlock::RULE_NET_PORT, &attr, 0u32) } < 0 {
			return Err(last_error(&format!("rule for TCP port {port}")));
		}
	}
	if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0 {
		return Err(last_error("no_new_privs"));
	}
	if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset.as_raw_fd(), 0u32) } < 0 {
		return Err(last_error("Landlock restrict_self"));
	}
	Ok(())
}

/// Refuses io_uring and any other architecture's calls (int 0x80, x32): Chromium uses none of them, and they are where
/// much of the kernel's attack surface has been. Chromium's own seccomp holds its renderers only.
fn refuse_unused_syscalls() -> Result<(), String> {
	const LD_W_ABS: u16 = (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16;
	const JEQ: u16 = (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16;
	const JGE: u16 = (libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K) as u16;
	const RET: u16 = (libc::BPF_RET | libc::BPF_K) as u16;
	const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
	const X32_SYSCALL_BIT: u32 = 0x4000_0000;
	let op = |code, jt, jf, k| libc::sock_filter { code, jt, jf, k };
	let filter = [
		op(LD_W_ABS, 0, 0, 4), // arch
		op(JEQ, 0, 4, AUDIT_ARCH_X86_64),
		op(LD_W_ABS, 0, 0, 0), // nr
		op(JGE, 2, 0, X32_SYSCALL_BIT),
		op(JEQ, 1, 0, libc::SYS_io_uring_setup as u32),
		op(RET, 0, 0, libc::SECCOMP_RET_ALLOW),
		op(RET, 0, 0, libc::SECCOMP_RET_ERRNO | libc::ENOSYS as u32),
	];
	let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_ptr().cast_mut() };
	if unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) } < 0 {
		return Err(last_error("seccomp"));
	}
	Ok(())
}

fn run() -> Result<Infallible, String> {
	let policy = Policy::from_env()?;
	restrict(&policy)?;
	refuse_unused_syscalls()?;
	let error = Command::new(&policy.program).args(env::args_os().skip(1)).env_remove(EXEC).env_remove(READ).env_remove(WRITE).env_remove(TCP).env_remove(UNIX).exec();
	Err(format!("{:?}: {error}", policy.program))
}

fn main() -> ExitCode {
	match run() {
		Ok(never) => match never {},
		Err(message) => {
			eprintln!("agent-sandbox: {message}");
			ExitCode::from(126)
		}
	}
}
