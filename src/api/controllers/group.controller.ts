import {
  AcceptGroupInvite,
  CreateGroupDto,
  GetParticipant,
  GroupDescriptionDto,
  GroupInvite,
  GroupJid,
  GroupJoinApprovalModeDto,
  GroupMemberAddModeDto,
  GroupPictureDto,
  GroupSendInvite,
  GroupSubjectDto,
  GroupToggleEphemeralDto,
  GroupUpdateParticipantDto,
  GroupUpdateParticipantRequestDto,
  GroupUpdateSettingDto,
} from '@api/dto/group.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { WAMonitoringService } from '@api/services/monitor.service';

export class GroupController {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  public async createGroup(instance: InstanceDto, create: CreateGroupDto) {
    return await this.waMonitor.waInstances[instance.instanceName].createGroup(create);
  }

  public async updateGroupPicture(instance: InstanceDto, update: GroupPictureDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGroupPicture(update);
  }

  public async updateGroupSubject(instance: InstanceDto, update: GroupSubjectDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGroupSubject(update);
  }

  public async updateGroupDescription(instance: InstanceDto, update: GroupDescriptionDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGroupDescription(update);
  }

  public async findGroupInfo(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].findGroup(groupJid);
  }

  public async fetchAllGroups(instance: InstanceDto, getPaticipants: GetParticipant) {
    return await this.waMonitor.waInstances[instance.instanceName].fetchAllGroups(getPaticipants);
  }

  public async inviteCode(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].inviteCode(groupJid);
  }

  public async inviteInfo(instance: InstanceDto, inviteCode: GroupInvite) {
    return await this.waMonitor.waInstances[instance.instanceName].inviteInfo(inviteCode);
  }

  public async sendInvite(instance: InstanceDto, data: GroupSendInvite) {
    return await this.waMonitor.waInstances[instance.instanceName].sendInvite(data);
  }

  public async acceptInviteCode(instance: InstanceDto, inviteCode: AcceptGroupInvite) {
    return await this.waMonitor.waInstances[instance.instanceName].acceptInviteCode(inviteCode);
  }

  public async revokeInviteCode(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].revokeInviteCode(groupJid);
  }

  public async findParticipants(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].findParticipants(groupJid);
  }

  public async updateGParticipate(instance: InstanceDto, update: GroupUpdateParticipantDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGParticipant(update);
  }

  public async updateGSetting(instance: InstanceDto, update: GroupUpdateSettingDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGSetting(update);
  }

  public async toggleEphemeral(instance: InstanceDto, update: GroupToggleEphemeralDto) {
    return await this.waMonitor.waInstances[instance.instanceName].toggleEphemeral(update);
  }

  public async updateMemberAddMode(instance: InstanceDto, update: GroupMemberAddModeDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateMemberAddMode(update);
  }

  public async updateJoinApprovalMode(instance: InstanceDto, update: GroupJoinApprovalModeDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateJoinApprovalMode(update);
  }

  public async findParticipantRequests(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].findParticipantRequests(groupJid);
  }

  public async updateParticipantRequests(instance: InstanceDto, update: GroupUpdateParticipantRequestDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateParticipantRequests(update);
  }

  public async leaveGroup(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].leaveGroup(groupJid);
  }
}
