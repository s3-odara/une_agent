//! Runs a program confined by Landlock, with the policy read from the environment: Playwright can give a browser only
//! an executable and its environment.
//!
//! - `AGENT_SANDBOX_EXEC`: the program, run with this program's arguments
//! - `AGENT_SANDBOX_READ`, `AGENT_SANDBOX_WRITE`: the paths (one per line) whose trees may be read and executed, or
//!   also written. Paths that do not exist are left out
//! - `AGENT_SANDBOX_TCP`: the TCP ports (one per line) that may be connected to; unset, any. TCP ports are never bound
//! - `AGENT_SANDBOX_UNIX=allow`: UNIX sockets outside the sandbox may be reached (a browser on a display needs them)
//!
//! Without `allow`, a seccomp filter also refuses new UNIX sockets: Landlock controls connecting to a socket by its
//! path only from ABI 9, which older kernels (likely Ubuntu 26.04's 7.0) lack, and the user's D-Bus would let the
//! program start anything outside the sandbox through systemd.

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
	pub const FS_FILE: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV;

	pub const NET_BIND_TCP: u64 = 1 << 0;
	pub const NET_CONNECT_TCP: u64 = 1 << 1;

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
	unix: bool,
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
			unix: env::var_os(UNIX).is_some_and(|value| value == "allow"),
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
	// Scopes (ABI 6) keep the program from abstract UNIX sockets and from signalling anything outside.
	if abi < 6 {
		return Err(format!("Landlock ABI {abi} is older than 6 (kernel 6.12)"));
	}
	Ok(abi)
}

fn handled_fs(abi: i64, unix: bool) -> u64 {
	let mut rights = landlock::FS_ABI1 | landlock::FS_REFER | landlock::FS_TRUNCATE | landlock::FS_IOCTL_DEV;
	if abi >= 9 && !unix {
		rights |= landlock::FS_RESOLVE_UNIX;
	}
	rights
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
	let abi = abi()?;
	let fs = handled_fs(abi, policy.unix);
	let attr = landlock::RulesetAttr {
		handled_access_fs: fs,
		handled_access_net: landlock::NET_BIND_TCP | if policy.tcp.is_some() { landlock::NET_CONNECT_TCP } else { 0 },
		scoped: landlock::SCOPE_SIGNAL | if policy.unix { 0 } else { landlock::SCOPE_ABSTRACT_UNIX_SOCKET },
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

/// Refuses socket(AF_UNIX, …), and io_uring, whose requests make sockets without that call. socketpair stays: Chromium's
/// processes talk through socket pairs. Any other architecture's calls (int 0x80, x32) are refused, as they would get
/// round the check.
fn refuse_unix_sockets() -> Result<(), String> {
	const LD_W_ABS: u16 = (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16;
	const JEQ: u16 = (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16;
	const JGE: u16 = (libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K) as u16;
	const RET: u16 = (libc::BPF_RET | libc::BPF_K) as u16;
	const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
	const X32_SYSCALL_BIT: u32 = 0x4000_0000;
	let op = |code, jt, jf, k| libc::sock_filter { code, jt, jf, k };
	let filter = [
		op(LD_W_ABS, 0, 0, 4), // arch
		op(JEQ, 0, 8, AUDIT_ARCH_X86_64),
		op(LD_W_ABS, 0, 0, 0), // nr
		op(JGE, 6, 0, X32_SYSCALL_BIT),
		op(JEQ, 5, 0, libc::SYS_io_uring_setup as u32),
		op(JEQ, 0, 2, libc::SYS_socket as u32),
		op(LD_W_ABS, 0, 0, 16), // args[0], the domain
		op(JEQ, 1, 0, libc::AF_UNIX as u32),
		op(RET, 0, 0, libc::SECCOMP_RET_ALLOW),
		op(RET, 0, 0, libc::SECCOMP_RET_ERRNO | libc::EACCES as u32),
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
	if !policy.unix {
		refuse_unix_sockets()?;
	}
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
