#[cfg(target_os = "windows")]
use std::{
	ffi::c_void,
	mem::{MaybeUninit, size_of},
};

use napi_derive::napi;
#[cfg(target_os = "windows")]
use windows_sys::Win32::{
	Foundation::GetLastError,
	System::{
		JobObjects::{
			IsProcessInJob, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
			JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOBOBJECT_LIMIT_VIOLATION_INFORMATION,
			JobObjectExtendedLimitInformation, JobObjectLimitViolationInformation,
			QueryInformationJobObject,
		},
		ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX},
		Threading::GetCurrentProcess,
	},
};

#[napi(object)]
pub struct WindowsJobMemoryProbeResult {
	pub kind: String,
	pub platform: String,
	#[napi(js_name = "isInJob")]
	pub is_in_job: Option<bool>,
	#[napi(js_name = "jobMemoryLimitBytes")]
	pub job_memory_limit_bytes: Option<String>,
	#[napi(js_name = "jobMemoryUsedBytes")]
	pub job_memory_used_bytes: Option<String>,
	#[napi(js_name = "peakJobMemoryUsedBytes")]
	pub peak_job_memory_used_bytes: Option<String>,
	#[napi(js_name = "processMemoryLimitBytes")]
	pub process_memory_limit_bytes: Option<String>,
	#[napi(js_name = "processPrivateUsageBytes")]
	pub process_private_usage_bytes: Option<String>,
	#[napi(js_name = "processWorkingSetBytes")]
	pub process_working_set_bytes: Option<String>,
	#[napi(js_name = "peakProcessWorkingSetBytes")]
	pub peak_process_working_set_bytes: Option<String>,
	pub call: Option<String>,
	pub code: Option<String>,
}

impl WindowsJobMemoryProbeResult {
	fn unsupported_platform() -> Self {
		Self {
			kind: "unsupported_platform".to_string(),
			platform: current_platform_tag().to_string(),
			is_in_job: None,
			job_memory_limit_bytes: None,
			job_memory_used_bytes: None,
			peak_job_memory_used_bytes: None,
			process_memory_limit_bytes: None,
			process_private_usage_bytes: None,
			process_working_set_bytes: None,
			peak_process_working_set_bytes: None,
			call: None,
			code: None,
		}
	}

	#[cfg(target_os = "windows")]
	fn not_in_job() -> Self {
		Self {
			kind: "not_in_job".to_string(),
			platform: current_platform_tag().to_string(),
			is_in_job: Some(false),
			job_memory_limit_bytes: None,
			job_memory_used_bytes: None,
			peak_job_memory_used_bytes: None,
			process_memory_limit_bytes: None,
			process_private_usage_bytes: None,
			process_working_set_bytes: None,
			peak_process_working_set_bytes: None,
			call: None,
			code: None,
		}
	}

	#[cfg(target_os = "windows")]
	fn api_error(call: &str, code: u32) -> Self {
		Self {
			kind: "api_error".to_string(),
			platform: current_platform_tag().to_string(),
			is_in_job: None,
			job_memory_limit_bytes: None,
			job_memory_used_bytes: None,
			peak_job_memory_used_bytes: None,
			process_memory_limit_bytes: None,
			process_private_usage_bytes: None,
			process_working_set_bytes: None,
			peak_process_working_set_bytes: None,
			call: Some(call.to_string()),
			code: Some(code.to_string()),
		}
	}

	#[cfg(target_os = "windows")]
	fn snapshot(
		limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
		usage: JOBOBJECT_LIMIT_VIOLATION_INFORMATION,
		counters: PROCESS_MEMORY_COUNTERS_EX,
	) -> Self {
		let limit_flags = limits.BasicLimitInformation.LimitFlags;
		let has_job_limit = limit_flags & JOB_OBJECT_LIMIT_JOB_MEMORY != 0;
		let has_process_limit = limit_flags & JOB_OBJECT_LIMIT_PROCESS_MEMORY != 0;
		Self {
			kind: "job_snapshot".to_string(),
			platform: current_platform_tag().to_string(),
			is_in_job: Some(true),
			job_memory_limit_bytes: has_job_limit.then(|| limits.JobMemoryLimit.to_string()),
			job_memory_used_bytes: Some(usage.JobMemory.to_string()),
			peak_job_memory_used_bytes: Some(limits.PeakJobMemoryUsed.to_string()),
			process_memory_limit_bytes: has_process_limit
				.then(|| limits.ProcessMemoryLimit.to_string()),
			process_private_usage_bytes: Some(counters.PrivateUsage.to_string()),
			process_working_set_bytes: Some(counters.WorkingSetSize.to_string()),
			peak_process_working_set_bytes: Some(counters.PeakWorkingSetSize.to_string()),
			call: None,
			code: None,
		}
	}
}

const fn current_platform_tag() -> &'static str {
	#[cfg(target_os = "windows")]
	{
		"win32"
	}
	#[cfg(target_os = "macos")]
	{
		"darwin"
	}
	#[cfg(target_os = "linux")]
	{
		"linux"
	}
	#[cfg(all(not(target_os = "windows"), not(target_os = "macos"), not(target_os = "linux")))]
	{
		std::env::consts::OS
	}
}

#[napi(js_name = "probeWindowsJobMemory")]
pub fn probe_windows_job_memory() -> WindowsJobMemoryProbeResult {
	#[cfg(target_os = "windows")]
	{
		let current_process = unsafe { GetCurrentProcess() };
		let mut in_job = 0;
		if unsafe { IsProcessInJob(current_process, std::ptr::null_mut(), &mut in_job) } == 0 {
			return WindowsJobMemoryProbeResult::api_error("IsProcessInJob", unsafe {
				GetLastError()
			});
		}
		if in_job == 0 {
			return WindowsJobMemoryProbeResult::not_in_job();
		}

		let mut limits = MaybeUninit::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>::zeroed();
		if unsafe {
			QueryInformationJobObject(
				std::ptr::null_mut(),
				JobObjectExtendedLimitInformation,
				limits.as_mut_ptr().cast::<c_void>(),
				size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
				std::ptr::null_mut(),
			)
		} == 0
		{
			return WindowsJobMemoryProbeResult::api_error("QueryInformationJobObject", unsafe {
				GetLastError()
			});
		}

		let mut usage = MaybeUninit::<JOBOBJECT_LIMIT_VIOLATION_INFORMATION>::zeroed();
		if unsafe {
			QueryInformationJobObject(
				std::ptr::null_mut(),
				JobObjectLimitViolationInformation,
				usage.as_mut_ptr().cast::<c_void>(),
				size_of::<JOBOBJECT_LIMIT_VIOLATION_INFORMATION>() as u32,
				std::ptr::null_mut(),
			)
		} == 0
		{
			return WindowsJobMemoryProbeResult::api_error(
				"QueryInformationJobObject(memory usage)",
				unsafe { GetLastError() },
			);
		}

		let mut counters = MaybeUninit::<PROCESS_MEMORY_COUNTERS_EX>::zeroed();
		unsafe {
			(*counters.as_mut_ptr()).cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
		}
		if unsafe {
			K32GetProcessMemoryInfo(
				current_process,
				counters.as_mut_ptr().cast(),
				size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
			)
		} == 0
		{
			return WindowsJobMemoryProbeResult::api_error("K32GetProcessMemoryInfo", unsafe {
				GetLastError()
			});
		}

		return WindowsJobMemoryProbeResult::snapshot(
			unsafe { limits.assume_init() },
			unsafe { usage.assume_init() },
			unsafe { counters.assume_init() },
		);
	}

	#[cfg(not(target_os = "windows"))]
	{
		WindowsJobMemoryProbeResult::unsupported_platform()
	}
}
