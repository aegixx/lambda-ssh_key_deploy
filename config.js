var config = {
	masterKeyBucket: 'acme-master-keys',
	ec2Tags: {
		name: 'Name',
		instanceFilter: 'auto_assign_keys',
		overridePort: 'auto_assign_ssh_port',
		overrideUser: 'auto_assign_ssh_user'
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
