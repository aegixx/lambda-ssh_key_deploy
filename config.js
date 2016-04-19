var config = {
	masterKeyBucket: 'acme-master-keys',
	ec2Tags: {
		name: 'Name',
		instanceFilter: 'ssh_key_deploy',
		overridePort: 'ssh_key_deploy-ssh_port',
		overrideUser: 'ssh_key_deploy-ssh_user',
		overrideUsePublicIP: 'ssh_key_deploy-use_public_ip'
	},
	ssh: {
		defaultUser: 'ec2-user',
		defaultPort: 22
	},
	logging: {
		traceEnabled: false,
		debugEnabled: false
	}
};

module.exports = config;
