/******************************************************************************************
Synchronizes an ACL on a Fastly service with a current list from 
https://check.torproject.org/cgi-bin/TorBulkExitList.py?ip=151.101.1.57

Requires a valid Fastly Service ID, ACL, and token in config.js
******************************************************************************************/

const conf = require(__dirname + "/config.js");
const async = require("async");
const axios = require("axios");
const fastly = require("fastly-promises");

let fastlyService = fastly(conf.fastlyKey, conf.serviceId);

fastlyService.getAclItems = function(aclId = conf.aclId){
	return this.request.get(`/service/${this.service_id}/acl/${aclId}/entries`);
}

fastlyService.patchAclItems = function(deltas, aclId = conf.aclId){
	return this.request.patch(`/service/${this.service_id}/acl/${aclId}/entries`, deltas);
}

fastlyService.request.defaults.timeout = 30000;


async.auto({
	get_tor_list: cb => {
		axios.get("https://check.torproject.org/cgi-bin/TorBulkExitList.py?ip=151.101.1.57")
			.then(res => {
				let ips = res.data.split("\n");

				//remove anything that doesn't look like an IP address
				ips = ips.filter(ip => ip.match(/^\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b$/));

				// uncomment to override the tor list for quick testing
				// ips = ["127.0.0.1"];

				cb(null, ips);
			})
			.catch(err => {
				cb(`Failed to retrieve Tor exit node list: ${err}`);
			});
	},
	get_fastly_list: cb => {
		fastlyService.getAclItems()
			.then(res => {
				cb(null, res.data.map(function(item){
					return {"ip": item.ip, "id": item.id};
				}));
			})
			.catch(err => {
				cb(`Failed to retrieve current ACL items: ${err.message}`);
			});
	},
	calc_deltas: ['get_tor_list', 'get_fastly_list', function(results, cb){
		class Delta{
			constructor(op, ip, id) {
				this.op = op; //"create" or "delete"
				if (op === "delete")
					this.id = id;
				else
					this.ip = ip;
			}
		}

		let deltas = [];
		//remove items that are in the fastly list but not the tor list
		results.get_fastly_list.forEach(item => {
			if (results.get_tor_list.indexOf(item.ip) == -1)
				deltas.push(new Delta("delete", item.ip, item.id));
		});

		//add items that are in the tor list but not in the fastly list
		results.get_tor_list.forEach(item => {
			if (results.get_fastly_list.map(fItem => fItem.ip).indexOf(item) == -1)
				deltas.push(new Delta("create", item));
		});
		cb(null, deltas);
	}],
	patch_dictionary: ['calc_deltas', (results, cb) => {
		let res = results.calc_deltas;
		var batches = res.chunk(500);

		async.each(batches, (batch, callback) => {
			console.log(`Batch: adding ${batch.filter(delta => delta.op === "create").length} items and removing ${batch.filter(delta => delta.op === "delete").length}.`);

			fastlyService.patchAclItems({"entries": batch})
				.then(result => {
					callback(null);
				})
				.catch(err => {
					let msg = `Failed to update ACL: ${err.response.data.detail}`;
					if (err.response && err.response.status === 400)
						msg += `\nYou may need to have Fastly increase your Maximum ACL Items.`;
					callback(msg);
				});

		}, err => {
				cb(err);
		});			
	}]
}, (err, results) => {
	if (err) {
		console.log(err);
	}
	console.log('Done.')
});


//helper for batching
Array.prototype.chunk = function(chunk_size){
	let results = [];
	while (this.length)
		results.push(this.splice(0, chunk_size));
	return results;
}